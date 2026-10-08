// Site settings. Edit this file to connect the sign-up form and update links;
// no other file needs to change. See website/README.md for step-by-step setup.
window.PATHWAYS_CONFIG = {
  // Where sign-ups are sent: "google" (Google Form, free, responses land in a
  // Google Sheet), "formspree" (formspree.io), or "" while not set up yet.
  signupProvider: "google",

  // For "google": the ID from your form's link, docs.google.com/forms/d/e/<ID>/viewform,
  // and the entry.NNNN name of each question (README explains how to find them).
  googleFormId: "1FAIpQLSfoGI4H_sVFmqQnJYyE0GYZKLYvOepG9i-3aP4XvAFc9ANBSg",
  googleFields: {
    name: "entry.1023181715",
    email: "entry.660938223",
    role: "entry.783137285",      // "I am…"
    platform: "entry.2110278569", // "Phone type"
    questions: "entry.357668315", // "Any questions?"
  },

  // For "formspree": the form endpoint, e.g. "https://formspree.io/f/abcdwxyz".
  formspreeEndpoint: "",

  // Once the app is live, paste its App Store link here. Every "Get notified"
  // button then becomes "Download on the App Store".
  appStoreUrl: "",

  // Optional: shown in the footer and FAQ when set.
  contactEmail: "",
};
