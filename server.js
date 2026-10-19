require("dotenv").config();

const path = require("node:path");
const express = require("express");
const cookieParser = require("cookie-parser");
const mysql = require("mysql2/promise");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const { randomUUID } = require("node:crypto");

// Check the settings needed to start the app.
const requiredEnvironment = ["DB_HOST", "DB_USER", "DB_NAME", "JWT_SECRET"];
const missingEnvironment = requiredEnvironment.filter((key) => !process.env[key]);

if (missingEnvironment.length) {
	throw new Error(`Missing required environment variables: ${missingEnvironment.join(", ")}`);
}
if (Buffer.byteLength(process.env.JWT_SECRET, "utf8") < 32) {
	throw new Error("JWT_SECRET must be at least 32 bytes. Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"");
}

const app = express();
const port = Number(process.env.PORT) || 5000;
const isProduction = process.env.NODE_ENV === "production";
const darajaEnvironment = process.env.DARAJA_ENV || "sandbox";
if (!["sandbox", "production"].includes(darajaEnvironment)) {
	throw new Error("DARAJA_ENV must be either sandbox or production.");
}
const darajaBaseUrl = darajaEnvironment === "production"
	? "https://api.safaricom.co.ke"
	: "https://sandbox.safaricom.co.ke";
const authCookieName = "access_token";
const authCookieOptions = {
	httpOnly: true,
	sameSite: "lax",
	secure: isProduction,
	maxAge: 7 * 24 * 60 * 60 * 1000,
	path: "/",
};

if (isProduction) app.set("trust proxy", 1);

// Set up the MySQL connection.
const databaseConfig = {
	host: process.env.DB_HOST,
	port: Number(process.env.DB_PORT) || 3306,
	user: process.env.DB_USER,
	password: process.env.DB_PASSWORD || "",
	database: process.env.DB_NAME,
};

const pool = mysql.createPool({
	...databaseConfig,
	waitForConnections: true,
	connectionLimit: 10,
	queueLimit: 0,
});

app.use(express.json({ limit: "10kb" }));
app.use(cookieParser());

// Authentication helpers.
function publicUser(user) {
	return { id: user.id, name: user.name, email: user.email };
}

// Sign user details into a token that expires after seven days.
function createAuthToken(user) {
	return jwt.sign(
		{ name: user.name, email: user.email },
		process.env.JWT_SECRET,
		{ algorithm: "HS256", subject: String(user.id), expiresIn: "7d" },
	);
}

function setAuthCookie(response, user) {
	response.cookie(authCookieName, createAuthToken(user), authCookieOptions);
}

function normalizeEmail(email) {
	return typeof email === "string" ? email.trim().toLowerCase() : "";
}

function validEmail(email) {
	return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254;
}

// Create the user table and migrate older password data safely.
async function ensureUsersTable() {
	await pool.execute(`
		CREATE TABLE IF NOT EXISTS users (
			id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
			name VARCHAR(100) NOT NULL,
			email VARCHAR(254) NOT NULL UNIQUE,
			password_hash VARCHAR(60) NOT NULL,
			created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
		)
	`);

	// Check the existing table so older installations can be upgraded safely.
	const [columns] = await pool.query("SHOW COLUMNS FROM users");
	const columnNames = new Set(columns.map((column) => column.Field));
	const hasLegacyPassword = columnNames.has("password");

	if (!columnNames.has("password_hash")) {
		await pool.execute("ALTER TABLE users ADD COLUMN password_hash VARCHAR(60) NULL");
	}

	const [usersWithoutPasswordHash] = await pool.execute(
		"SELECT id, password_hash" + (hasLegacyPassword ? ", password" : "") + " FROM users WHERE password_hash IS NULL",
	);
	if (usersWithoutPasswordHash.length && !hasLegacyPassword) {
		throw new Error("Cannot migrate users without password_hash because no legacy password column exists.");
	}

	for (const user of usersWithoutPasswordHash) {
		if (typeof user.password !== "string") {
			throw new Error("Cannot migrate a user without a legacy password value.");
		}
		// Keep bcrypt hashes; hash older plain-text passwords before saving.
		const passwordHash = /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/.test(user.password)
			? user.password
			: await bcrypt.hash(user.password, 12);
		await pool.execute("UPDATE users SET password_hash = ? WHERE id = ? AND password_hash IS NULL", [passwordHash, user.id]);
	}

	if (hasLegacyPassword) {
		await pool.execute("ALTER TABLE users MODIFY password VARCHAR(255) NULL");
		await pool.execute("UPDATE users SET password = NULL WHERE password IS NOT NULL");
	}
	await pool.execute("ALTER TABLE users MODIFY password_hash VARCHAR(60) NOT NULL");
}

// Create the table used to track fare payment requests.
async function ensurePaymentsTable() {
	await pool.execute(`
		CREATE TABLE IF NOT EXISTS fare_payments (
			id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
			user_id BIGINT UNSIGNED NOT NULL,
			account_reference VARCHAR(32) NOT NULL UNIQUE,
			phone_number VARCHAR(12) NOT NULL,
			amount INT UNSIGNED NOT NULL,
			status VARCHAR(20) NOT NULL DEFAULT 'initiating',
			merchant_request_id VARCHAR(64) NULL,
			checkout_request_id VARCHAR(64) NULL UNIQUE,
			mpesa_receipt_number VARCHAR(32) NULL UNIQUE,
			result_description VARCHAR(255) NULL,
			created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
			updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
			INDEX fare_payments_user_created (user_id, created_at),
			INDEX fare_payments_user_status (user_id, status)
		)
	`);
}

// Daraja helpers.
function normalizePhoneNumber(phone) {
	const compactPhone = phone.replace(/[\s()+-]/g, "");
	if (/^0(?:7|1)\d{8}$/.test(compactPhone)) return `254${compactPhone.slice(1)}`;
	if (/^254(?:7|1)\d{8}$/.test(compactPhone)) return compactPhone;
	return "";
}

function getDarajaConfiguration() {
	const required = [
		"DARAJA_CONSUMER_KEY",
		"DARAJA_CONSUMER_SECRET",
		"DARAJA_SHORTCODE",
		"DARAJA_PARTY_B",
		"DARAJA_PASSKEY",
		"DARAJA_CALLBACK_URL",
	];
	const missing = required.filter((key) => !process.env[key]);
	if (missing.length) {
		throw new Error(`Missing Daraja configuration: ${missing.join(", ")}`);
	}
	let callbackUrl;
	try {
		callbackUrl = new URL(process.env.DARAJA_CALLBACK_URL);
	} catch {
		throw new Error("DARAJA_CALLBACK_URL must be a publicly reachable HTTPS URL.");
	}
	if (callbackUrl.protocol !== "https:") {
		throw new Error("DARAJA_CALLBACK_URL must be a publicly reachable HTTPS URL.");
	}
	if (["localhost", "127.0.0.1", "::1"].includes(callbackUrl.hostname)) {
		throw new Error("DARAJA_CALLBACK_URL must be publicly reachable by Safaricom.");
	}
	const transactionType = process.env.DARAJA_TRANSACTION_TYPE || "CustomerPayBillOnline";
	if (!["CustomerPayBillOnline", "CustomerBuyGoodsOnline"].includes(transactionType)) {
		throw new Error("DARAJA_TRANSACTION_TYPE must be CustomerPayBillOnline or CustomerBuyGoodsOnline.");
	}
	return {
		consumerKey: process.env.DARAJA_CONSUMER_KEY,
		consumerSecret: process.env.DARAJA_CONSUMER_SECRET,
		shortcode: process.env.DARAJA_SHORTCODE,
		partyB: process.env.DARAJA_PARTY_B,
		passkey: process.env.DARAJA_PASSKEY,
		callbackUrl: callbackUrl.toString(),
		transactionType,
	};
}

function darajaTimestamp() {
	const parts = new Intl.DateTimeFormat("en-GB", {
		timeZone: "Africa/Nairobi",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hourCycle: "h23",
	}).formatToParts(new Date());
	const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
	return `${values.year}${values.month}${values.day}${values.hour}${values.minute}${values.second}`;
}

// Ask Daraja to send a payment prompt to the customer's phone.
async function sendStkPush({ phoneNumber, amount, accountReference, configuration }) {
	const authorization = Buffer.from(`${configuration.consumerKey}:${configuration.consumerSecret}`).toString("base64");
	const tokenResponse = await fetch(`${darajaBaseUrl}/oauth/v1/generate?grant_type=client_credentials`, {
		headers: { Authorization: `Basic ${authorization}` },
		signal: AbortSignal.timeout(15000),
	});
	const tokenResult = await tokenResponse.json();
	if (!tokenResponse.ok || typeof tokenResult.access_token !== "string") {
		throw new Error(`Daraja access token request failed (HTTP ${tokenResponse.status}).`);
	}

	// Daraja builds its request password from the shortcode, passkey, and timestamp.
	const timestamp = darajaTimestamp();
	const password = Buffer.from(`${configuration.shortcode}${configuration.passkey}${timestamp}`).toString("base64");
	const pushResponse = await fetch(`${darajaBaseUrl}/mpesa/stkpush/v1/processrequest`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${tokenResult.access_token}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			BusinessShortCode: configuration.shortcode,
			Password: password,
			Timestamp: timestamp,
			TransactionType: configuration.transactionType,
			Amount: amount,
			PartyA: phoneNumber,
			PartyB: configuration.partyB,
			PhoneNumber: phoneNumber,
			CallBackURL: configuration.callbackUrl,
			AccountReference: accountReference,
			TransactionDesc: "Fare payment",
		}),
		signal: AbortSignal.timeout(15000),
	});
	const pushResult = await pushResponse.json();
	if (!pushResponse.ok || pushResult.ResponseCode !== "0" ||
		typeof pushResult.CheckoutRequestID !== "string" ||
		typeof pushResult.MerchantRequestID !== "string") {
		throw new Error(`Daraja STK Push request failed (HTTP ${pushResponse.status}).`);
	}
	return pushResult;
}

// Account routes.
app.post("/api/auth/register", async (request, response, next) => {
	const body = request.body || {};
	const name = typeof body.name === "string" ? body.name.trim() : "";
	const email = normalizeEmail(body.email);
	const password = body.password;

	if (
		!name ||
		name.length > 100 ||
		!validEmail(email) ||
		typeof password !== "string" ||
		password.length < 6 ||
		password.length > 72 ||
		Buffer.byteLength(password, "utf8") > 72
	) {
		return response.status(400).json({ error: "Enter a name, valid email, and password between 6 and 72 characters (maximum 72 UTF-8 bytes)." });
	}

	try {
		// Store a bcrypt hash instead of the password itself.
		const passwordHash = await bcrypt.hash(password, 12);
		const [result] = await pool.execute(
			"INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)",
			[name, email, passwordHash],
		);

		const user = { id: result.insertId, name, email };
		setAuthCookie(response, user);
		response.status(201).json({ user });
	} catch (error) {
		if (error.code === "ER_DUP_ENTRY") {
			return response.status(409).json({ error: "An account with that email already exists." });
		}
		next(error);
	}
});

app.post("/api/auth/login", async (request, response, next) => {
	const body = request.body || {};
	const email = normalizeEmail(body.email);
	const password = body.password;

	if (!validEmail(email) || typeof password !== "string") {
		return response.status(400).json({ error: "Enter a valid email and password." });
	}

	try {
		const [users] = await pool.execute(
			"SELECT id, name, email, password_hash FROM users WHERE email = ? LIMIT 1",
			[email],
		);
		const user = users[0];

		if (!user || !(await bcrypt.compare(password, user.password_hash))) {
			return response.status(401).json({ error: "Email or password is incorrect." });
		}

		const authenticatedUser = publicUser(user);
		setAuthCookie(response, authenticatedUser);
		response.json({ user: authenticatedUser });
	} catch (error) {
		next(error);
	}
});

// Check the signed cookie before allowing access to protected routes.
function requireAuthentication(request, response, next) {
	const token = request.cookies?.[authCookieName];
	if (!token) {
		return response.status(401).json({ error: "Not signed in." });
	}

	try {
		// Trust the user ID only after the token signature has been checked.
		const claims = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ["HS256"] });
		if (
			typeof claims === "string" ||
			!claims.sub ||
			typeof claims.name !== "string" ||
			typeof claims.email !== "string"
		) {
			return response.status(401).json({ error: "Invalid authentication token." });
		}
		response.locals.user = { id: claims.sub, name: claims.name, email: claims.email };
		next();
	} catch (error) {
		if (error instanceof jwt.JsonWebTokenError || error instanceof jwt.TokenExpiredError) {
			return response.status(401).json({ error: "Invalid or expired authentication token." });
		}
		next(error);
	}
}

// Dashboard and payment routes.
app.get("/api/dashboard", requireAuthentication, async (request, response, next) => {
	try {
		const userId = response.locals.user.id;
		const [todayTotals] = await pool.execute(`
			SELECT
				COALESCE(SUM(CASE WHEN status = 'paid' THEN amount ELSE 0 END), 0) AS paid_amount,
				SUM(status = 'paid') AS paid_count,
				COALESCE(SUM(CASE WHEN status IN ('initiating', 'pending') THEN amount ELSE 0 END), 0) AS pending_amount,
				SUM(status IN ('initiating', 'pending')) AS pending_count
			FROM fare_payments
			WHERE user_id = ? AND DATE(created_at) = CURRENT_DATE()
		`, [userId]);
		const [payments] = await pool.execute(`
			SELECT id, phone_number, amount, status, result_description, created_at
			FROM fare_payments
			WHERE user_id = ?
			ORDER BY created_at DESC
			LIMIT 10
		`, [userId]);
		response.json({
			today: {
				paidAmount: Number(todayTotals[0].paid_amount),
				paidCount: Number(todayTotals[0].paid_count || 0),
				pendingAmount: Number(todayTotals[0].pending_amount),
				pendingCount: Number(todayTotals[0].pending_count || 0),
			},
			payments,
		});
	} catch (error) {
		next(error);
	}
});

app.post("/api/fares/stk-push", requireAuthentication, async (request, response, next) => {
	const phoneNumber = typeof request.body?.phone === "string" ? normalizePhoneNumber(request.body.phone) : "";
	const amount = Number(request.body?.amount);
	if (!phoneNumber || !Number.isSafeInteger(amount) || amount < 1 || amount > 250000) {
		return response.status(400).json({ error: "Enter a valid Kenyan mobile number and a whole fare amount from KES 1 to KES 250,000." });
	}

	let configuration;
	try {
		configuration = getDarajaConfiguration();
	} catch (error) {
		console.error("Could not initiate Daraja STK Push.", error);
		return response.status(503).json({
			error: error.message.startsWith("Missing Daraja configuration:")
				? "M-PESA prompting is not configured. Set the Daraja credentials and public callback URL."
				: "Set DARAJA_CALLBACK_URL to a publicly reachable HTTPS URL and check the Daraja configuration.",
		});
	}

	const accountReference = `FARE${randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase()}`;
	let paymentId;
	try {
		const [insertResult] = await pool.execute(
			"INSERT INTO fare_payments (user_id, account_reference, phone_number, amount, status) VALUES (?, ?, ?, ?, 'initiating')",
			[response.locals.user.id, accountReference, phoneNumber, amount],
		);
		paymentId = insertResult.insertId;
	} catch (error) {
		return next(error);
	}

	let pushResult;
	try {
		pushResult = await sendStkPush({ phoneNumber, amount, accountReference, configuration });
	} catch (error) {
		const timedOut = error.name === "AbortError" || error.name === "TimeoutError";
		try {
			await pool.execute(
				"UPDATE fare_payments SET status = ?, result_description = ? WHERE id = ? AND status = 'initiating'",
				[
					timedOut ? "pending" : "failed",
					timedOut ? "M-PESA response timed out; prompt status is unknown." : "Could not send the M-PESA prompt.",
					paymentId,
				],
			);
		} catch (databaseError) {
			return next(databaseError);
		}
		console.error("Could not initiate Daraja STK Push.", error);
		if (timedOut) {
			return response.status(504).json({ error: "The M-PESA service timed out. Check payment activity before retrying; the prompt status may be unknown." });
		}
		return response.status(502).json({ error: "Could not send the M-PESA prompt. Check the Daraja configuration and try again." });
	}

	try {
		await pool.execute(`
			UPDATE fare_payments
			SET merchant_request_id = ?, checkout_request_id = ?,
				status = IF(status = 'initiating', 'pending', status)
			WHERE id = ?
		`, [pushResult.MerchantRequestID, pushResult.CheckoutRequestID, paymentId]);
	} catch (error) {
		return next(error);
	}
	response.status(202).json({ status: "pending", message: "M-PESA prompt sent. Ask the customer to check their phone and enter their PIN." });
});

// Daraja calls this route with the final payment result.
app.post("/api/payments/daraja/callback", async (request, response, next) => {
	const callback = request.body?.Body?.stkCallback;
	const resultCode = callback?.ResultCode;
	const validResultCode = (typeof resultCode === "number" && Number.isInteger(resultCode)) ||
		(typeof resultCode === "string" && /^\d+$/.test(resultCode));
	if (!callback || typeof callback.CheckoutRequestID !== "string" || !validResultCode) {
		return response.status(400).json({ error: "Invalid Daraja callback payload." });
	}

	try {
		// A nonzero result means the customer did not complete the payment.
		if (Number(resultCode) !== 0) {
			const [result] = await pool.execute(`
				UPDATE fare_payments
				SET status = 'failed', result_description = ?
				WHERE checkout_request_id = ? AND status IN ('initiating', 'pending')
			`, [String(callback.ResultDesc || "M-PESA payment was not completed.").slice(0, 255), callback.CheckoutRequestID]);
			if (!result.affectedRows) {
				console.warn("Ignored unmatched Daraja failure callback.", callback.CheckoutRequestID);
			}
			return response.json({ ResultCode: 0, ResultDesc: "Accepted" });
		}

		const metadataItems = callback.CallbackMetadata?.Item;
		if (!Array.isArray(metadataItems) || metadataItems.some((item) => !item || typeof item.Name !== "string")) {
			return response.status(400).json({ error: "Successful Daraja callback is missing payment metadata." });
		}
		const metadata = Object.fromEntries(metadataItems.map((item) => [item.Name, item.Value]));
		const amount = Number(metadata.Amount);
		const receipt = metadata.MpesaReceiptNumber;
		const phoneNumber = typeof metadata.PhoneNumber === "number" || typeof metadata.PhoneNumber === "string"
			? normalizePhoneNumber(String(metadata.PhoneNumber))
			: "";
		if (
			!Number.isSafeInteger(amount) ||
			typeof receipt !== "string" ||
			!receipt ||
			receipt.length > 32 ||
			!phoneNumber
		) {
			return response.status(400).json({ error: "Successful Daraja callback has invalid payment details." });
		}

		const [result] = await pool.execute(`
			UPDATE fare_payments
			SET status = 'paid', mpesa_receipt_number = ?, result_description = 'Payment confirmed'
			WHERE checkout_request_id = ? AND amount = ? AND phone_number = ?
				AND status IN ('initiating', 'pending')
		`, [receipt, callback.CheckoutRequestID, amount, phoneNumber]);
		if (!result.affectedRows) {
			console.warn("Ignored unmatched Daraja payment callback.", callback.CheckoutRequestID);
		}
		response.json({ ResultCode: 0, ResultDesc: "Accepted" });
	} catch (error) {
		next(error);
	}
});

app.get("/api/auth/me", requireAuthentication, (request, response) => {
	response.json({ user: response.locals.user });
});

app.post("/api/auth/logout", (request, response) => {
	response.clearCookie(authCookieName, {
		httpOnly: true,
		sameSite: "lax",
		secure: isProduction,
		path: "/",
	});
	response.status(204).end();
});

app.use(express.static(path.join(__dirname, "public")));

app.use((error, request, response, next) => {
	console.error(error);
	if (response.headersSent) return next(error);
	response.status(500).json({ error: "The server could not complete the request." });
});

// Finish database setup before the server accepts requests.
async function start() {
	await ensureUsersTable();
	await ensurePaymentsTable();

	app.listen(port, () => {
		console.log(`Server listening on http://localhost:${port}`);
	});
}

start().catch((error) => {
	console.error("Could not start the server. Check the MySQL connection and database configuration.", error);
	process.exit(1);
});