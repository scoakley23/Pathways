# Pathways USA website

The pre-launch website for the Pathways app: what it does, the nonprofit's mission, an FAQ,
and a sign-up form so people can be notified when the app is on the App Store.

It's plain HTML, CSS, and JavaScript with no build step and no server, so it can be hosted
for free indefinitely.

| File | Purpose |
| --- | --- |
| `index.html` | All page content (edit text here) |
| `styles.css` | Colors, fonts, layout |
| `config.js` | **Settings: sign-up form, App Store link, contact email** |
| `main.js` | Sign-up form behavior |
| `assets/` | Logos, favicon, and the image shown when the link is shared |

Preview locally: `cd website && python3 -m http.server 8000`, then open <http://localhost:8000>.

## 1. Connect the sign-up form (Google Form, free)

Sign-ups go into a Google Sheet you own. No account limits, nothing to pay for.

1. Create a new form at <https://forms.google.com> with four **Short answer** questions,
   in this order: `Name`, `Email`, `Role`, `Phone`. Don't require sign-in
   (Settings → Responses → "Restrict to users in your organization" off, "Collect email
   addresses" off).
2. In the **Responses** tab, click **Link to Sheets** so sign-ups land in a spreadsheet.
3. Click **⋮ → Get pre-filled link**, type `NAME`, `EMAIL`, `ROLE`, `PHONE` into the four
   answers, click **Get link**, then **Copy link**. It looks like:
   ```
   https://docs.google.com/forms/d/e/1FAIpQLSd.../viewform?usp=pp_url&entry.111=NAME&entry.222=EMAIL&entry.333=ROLE&entry.444=PHONE
   ```
4. Fill in `config.js` from that link:
   ```js
   signupProvider: "google",
   googleFormId: "1FAIpQLSd...",          // the part between /e/ and /viewform
   googleFields: {
     name: "entry.111",
     email: "entry.222",
     role: "entry.333",
     platform: "entry.444",
   },
   ```
5. Open the site, sign up with your own email, and check that a row appears in the Sheet.

**Alternative:** [Formspree](https://formspree.io) (free plan: 50 sign-ups a month, sends
each one to your inbox). Create a form, then set `signupProvider: "formspree"` and
`formspreeEndpoint: "https://formspree.io/f/xxxxxxx"`.

Until one of these is set up, the form shows "Sign-ups aren't connected yet", so you'll
notice before sharing the link.

## 2. Put it online (free)

Any static host works. Two good free options that won't expire:

- **Netlify** (easiest): go to <https://app.netlify.com/drop> and drag the `website`
  folder onto the page. To update it later, drag the folder again, or connect the GitHub
  repo with **Base directory** `website` and an empty build command so it redeploys on
  every push.
- **Cloudflare Pages**: Workers & Pages → Create → Pages → connect this GitHub repo,
  framework preset **None**, build command empty, **build output directory** `website`.

Both give you a free `*.netlify.app` / `*.pages.dev` address and let you add your own
domain (e.g. `pathwaysusa.org`) later.

After it's live, change the `og:image` line in `index.html` to the full address
(e.g. `https://pathwaysusa.org/assets/og-image.png`) so the logo shows up when the link is
shared in texts and social media.

## 3. When the app launches

Paste the App Store link into `appStoreUrl` in `config.js` and redeploy. Every "Get
notified" button turns into "Download on the App Store", and the sign-up section changes to
"Pathways is here!". Then email everyone in your sign-up Sheet.
