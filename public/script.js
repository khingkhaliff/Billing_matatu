// Keep track of the selected account mode and dashboard refresh timer.
let authMode = "login";
let dashboardRefreshTimer;

const kesFormatter = new Intl.NumberFormat("en-KE", {
  maximumFractionDigits: 0,
});

function formatKes(amount) {
  return `KES ${kesFormatter.format(amount)}`;
}

// Open a clean fare form.
function openFarePayment() {
  const form = document.querySelector("#fare-form");
  form.reset();
  document.querySelector("#fare-details-error").textContent = "";
  document.querySelector("#fare-details-success").textContent = "";
  form.querySelector('[type="submit"]').disabled = false;
  document.querySelector("#fare-modal").showModal();
  document.querySelector("#customer-number").focus();
}

function formatPhoneNumber(value) {
  return value.replace(/[\s()-]/g, "");
}

document.querySelectorAll("[data-close]").forEach((button) => {
  button.addEventListener("click", () => button.closest("dialog").close());
});

document.querySelector('[data-action="pay-fare"]').addEventListener("click", openFarePayment);

// Validate the form before asking the server to send an STK prompt.
document.querySelector("#fare-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const phone = formatPhoneNumber(document.querySelector("#customer-number").value);
  const amount = Number(document.querySelector("#fare-amount").value);
  const phonePattern = /^(?:\+?254|0)(?:7\d{8}|1\d{8})$/;
  const error = document.querySelector("#fare-details-error");
  const success = document.querySelector("#fare-details-success");
  const submit = document
    .querySelector("#fare-form")
    .querySelector('[type="submit"]');
  error.textContent = "";
  success.textContent = "";

  if (!phonePattern.test(phone)) {
    error.textContent = "Enter a valid Kenyan mobile number, such as 0712 345 678.";
    document.querySelector("#customer-number").focus();
    return;
  }

  if (
    !Number.isInteger(amount) ||
    amount <= 0 ||
    amount > 250000
  ) {
    error.textContent = "Enter a whole fare amount from KES 1 to KES 250,000.";
    document.querySelector("#fare-amount").focus();
    return;
  }

  submit.disabled = true;
  fetch("/api/fares/stk-push", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify({ phone, amount }),
  })
    .then(async (response) => {
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Could not send the M-PESA prompt.");
      success.textContent = result.message;
      document.querySelector("#fare-form").reset();
      loadDashboard();
    })
    .catch((requestError) => {
      error.textContent = requestError.message || "Could not connect to the server. Try again.";
    })
    .finally(() => {
      submit.disabled = false;
    });
});

// Account sign-in and sign-up controls.
const authModal = document.querySelector("#auth-modal");
const authForm = document.querySelector("#auth-form");
const authTitle = document.querySelector("#auth-title");
const authSubmit = document.querySelector("#auth-submit");

function setAuthMode(mode) {
  authMode = mode;
  const signup = mode === "signup";
  authTitle.textContent = signup ? "Create your account" : "Welcome back";
  authSubmit.textContent = signup ? "Create account" : "Log in";
  document.querySelector("#signup-name-field").hidden = !signup;
  document.querySelector("#account-name").required = signup;
  document.querySelector("#account-password").autocomplete = signup ? "new-password" : "current-password";
  document.querySelector("#auth-error").textContent = "";
  document.querySelectorAll("[data-auth-mode]").forEach((button) => {
    const selected = button.dataset.authMode === mode;
    button.classList.toggle("is-active", selected);
    button.setAttribute("aria-pressed", String(selected));
  });
}

document.querySelectorAll("[data-auth-mode]").forEach((button) => {
  button.addEventListener("click", () => setAuthMode(button.dataset.authMode));
});

function showDashboard(user) {
  document.querySelector("#account-display-name").textContent = user.name;
  document.querySelector(".dashboard").hidden = false;
  if (authModal.open) authModal.close();
  loadDashboard();
  if (!dashboardRefreshTimer) {
    dashboardRefreshTimer = window.setInterval(() => {
      const dashboardIsVisible = !document.querySelector(".dashboard").hidden;
      if (dashboardIsVisible && !document.hidden) {
        loadDashboard();
      }
    }, 15000);
  }
}
                                                                                                                                          
function createTextElement(tagName, className, text) {
  const element = document.createElement(tagName);
  element.className = className;
  element.textContent = text;
  return element;
}

// Turn payment records into the list shown on the dashboard.
function renderFareActivity(payments) {
  const fareList = document.querySelector("#fare-list");
  fareList.replaceChildren();
  if (!payments.length) {
    fareList.append(createTextElement("p", "empty-state", "No fare payments yet. Use Pay fare to send your first M-PESA prompt."));
    return;
  }

  for (const payment of payments) {
    const row = document.createElement("article");
    row.className = `fare-row fare-row-${payment.status}`;
    const icon = createTextElement("span", "fare-icon", payment.status === "paid" ? "OK" : "MP");
    const description = document.createElement("div");
    description.className = "fare-description";
    description.append(createTextElement("p", "", `Customer *** ${payment.phone_number.slice(-4)}`));
    const createdAt = new Date(payment.created_at);
    description.append(createTextElement("time", "", Number.isNaN(createdAt.getTime()) ? "Date unavailable" : createdAt.toLocaleString()));
    const value = document.createElement("div");
    value.className = "fare-value";
    value.append(createTextElement("strong", "", formatKes(Number(payment.amount))));
    const statusLabels = {
      paid: payment.mpesa_receipt_number ? `Paid · ${payment.mpesa_receipt_number}` : "Paid",
      pending: payment.result_description?.includes("unknown")
        ? "Payment status unknown; check before retrying"
        : "Awaiting payment",
      initiating: "Sending prompt",
      failed: payment.result_description || "Not paid",
    };
    value.append(createTextElement("span", "", statusLabels[payment.status] || "Status unavailable"));
    row.append(icon, description, value);
    fareList.append(row);
  }
}

// Fetch the latest totals and payment activity.
async function loadDashboard() {
  const error = document.querySelector("#dashboard-error");
  try {
    const response = await fetch("/api/dashboard", { credentials: "same-origin" });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Could not load dashboard data.");
    document.querySelector("#balance-amount").textContent = formatKes(result.today.paidAmount);
    document.querySelector("#today-total").textContent = formatKes(result.today.pendingAmount);
    document.querySelector("#completed-fares").textContent = String(result.today.paidCount);
    document.querySelector("#completed-note").textContent = `${formatKes(result.today.paidAmount)} paid today`;
    document.querySelector("#pending-payments").textContent = String(result.today.pendingCount);
    document.querySelector("#pending-note").textContent =
      `${formatKes(result.today.pendingAmount)} awaiting customer response`;
    renderFareActivity(result.payments);
    error.textContent = "";
  } catch (requestError) {
    error.textContent = requestError.message || "Could not refresh dashboard data.";
  }
}

document.querySelector("#refresh-dashboard").addEventListener("click", loadDashboard);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && !document.querySelector(".dashboard").hidden) loadDashboard();
});

// Submit the selected sign-in or sign-up form.
authForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const name = document.querySelector("#account-name").value.trim();
  const email = document.querySelector("#account-email");
  const password = document.querySelector("#account-password");
  const error = document.querySelector("#auth-error");
  if (
    (authMode === "signup" && !name) ||
    !email.validity.valid ||
    password.value.length < 6
  ) {
    error.textContent = authMode === "signup" && !name
      ? "Enter your name to create an account."
      : "Enter a valid email and a password with at least 6 characters.";
    return;
  }

  authSubmit.disabled = true;
  error.textContent = "";

  try {
    const response = await fetch(`/api/auth/${authMode === "signup" ? "register" : "login"}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ name, email: email.value.trim(), password: password.value }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Authentication failed.");
    authForm.reset();
    setAuthMode("login");
    showDashboard(result.user);
  } catch (requestError) {
    error.textContent = requestError.message || "Could not connect to the server. Try again.";
  } finally {
    authSubmit.disabled = false;
  }
});

authModal.addEventListener("cancel", (event) => {
  event.preventDefault();
});

document.querySelector("#logout-button").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  button.disabled = true;

  try {
    const response = await fetch("/api/auth/logout", { method: "POST", credentials: "same-origin" });
    if (!response.ok) throw new Error("Could not sign out. Try again.");
    document.querySelector(".dashboard").hidden = true;
    if (dashboardRefreshTimer) {
      window.clearInterval(dashboardRefreshTimer);
      dashboardRefreshTimer = undefined;
    }
    authForm.reset();
    setAuthMode("login");
    authModal.showModal();
  } catch (error) {
    window.alert(error.message || "Could not connect to the server. Try again.");
  } finally {
    button.disabled = false;
  }
});

async function restoreAuthentication() {
  try {
    const response = await fetch("/api/auth/me", { credentials: "same-origin" });
    if (!response.ok) throw new Error("Not signed in.");
    const result = await response.json();
    showDashboard(result.user);
  } catch {
    authModal.showModal();
  }
}

restoreAuthentication();
