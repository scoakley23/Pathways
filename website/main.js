(() => {
  const config = window.PATHWAYS_CONFIG || {};
  const form = document.getElementById("signup-form");
  const statusEl = document.getElementById("form-status");
  const emailInput = document.getElementById("f-email");
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

  document.getElementById("year").textContent = new Date().getFullYear();

  // Contact email (optional).
  if (config.contactEmail) {
    const mailto = `mailto:${config.contactEmail}`;
    const footerLink = document.querySelector(".js-contact");
    footerLink.href = mailto;
    footerLink.hidden = false;
    const faq = document.querySelector(".js-contact-faq");
    faq.textContent = "";
    faq.append("email us at ");
    const a = document.createElement("a");
    a.href = mailto;
    a.textContent = config.contactEmail;
    faq.append(a);
  }

  // Once the app is live, point every call to action at the App Store.
  if (config.appStoreUrl) {
    document.querySelectorAll(".js-cta").forEach((el) => {
      el.href = config.appStoreUrl;
      el.textContent = el.classList.contains("btn-sm") ? "Download" : "Download on the App Store";
    });
    const storeBtn = document.querySelector(".appstore-btn");
    storeBtn.href = config.appStoreUrl;
    storeBtn.hidden = false;
    document.querySelector(".pill").lastChild.textContent = " Now available on the App Store";
    document.querySelector(".js-signup-title").textContent = "Pathways is here!";
    document.querySelector(".js-signup-text").textContent =
      "Download the app on the App Store, or sign up below for news and updates from Pathways USA.";
  }

  function setStatus(message, kind) {
    statusEl.textContent = message;
    statusEl.className = `form-status ${kind || ""}`;
  }

  async function send(data) {
    if (config.signupProvider === "google") {
      const fields = config.googleFields || {};
      if (!config.googleFormId || !fields.email) throw new Error("Google Form is not fully configured.");
      const body = new URLSearchParams();
      for (const key of ["name", "email", "role", "platform"]) {
        if (fields[key]) body.append(fields[key], data[key] || "");
      }
      // Google Forms doesn't allow reading the response cross-origin, so a
      // completed request is treated as success.
      await fetch(`https://docs.google.com/forms/d/e/${encodeURIComponent(config.googleFormId)}/formResponse`, {
        method: "POST",
        mode: "no-cors",
        body,
      });
      return;
    }
    if (config.signupProvider === "formspree") {
      if (!config.formspreeEndpoint) throw new Error("Formspree endpoint is not configured.");
      const res = await fetch(config.formspreeEndpoint, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      if (!res.ok) throw new Error(`Formspree returned ${res.status}`);
      return;
    }
    throw new Error("NOT_CONFIGURED");
  }

  function showThanks(name) {
    form.classList.add("done");
    form.replaceChildren();
    const img = document.createElement("img");
    img.src = "assets/icon.png";
    img.alt = "";
    img.className = "done-icon";
    const h = document.createElement("h3");
    h.textContent = name ? `Thank you, ${name}!` : "Thank you!";
    const p = document.createElement("p");
    p.className = "muted";
    p.textContent = config.appStoreUrl
      ? "You're on the list for news and updates from Pathways USA."
      : "You're on the list. We'll email you as soon as Pathways is on the App Store.";
    form.append(img, h, p);
    form.setAttribute("tabindex", "-1");
    form.focus();
  }

  emailInput.addEventListener("input", () => emailInput.removeAttribute("aria-invalid"));

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const fd = new FormData(form);
    if (fd.get("company")) return; // spam bot filled the hidden field

    const data = {
      name: String(fd.get("name") || "").trim(),
      email: String(fd.get("email") || "").trim(),
      role: String(fd.get("role") || ""),
      platform: String(fd.get("platform") || ""),
    };
    if (!EMAIL_RE.test(data.email)) {
      emailInput.setAttribute("aria-invalid", "true");
      emailInput.focus();
      setStatus("Please enter a valid email address.", "err");
      return;
    }

    const button = form.querySelector("button[type=submit]");
    button.disabled = true;
    button.textContent = "Signing you up…";
    setStatus("");
    try {
      await send(data);
      showThanks(data.name);
    } catch (err) {
      console.error(err);
      button.disabled = false;
      button.textContent = "Notify me";
      setStatus(
        err.message === "NOT_CONFIGURED"
          ? "Sign-ups aren't connected yet. (Site owner: set signupProvider in config.js.)"
          : "Sorry, something went wrong. Please try again in a moment.",
        "err",
      );
    }
  });
})();
