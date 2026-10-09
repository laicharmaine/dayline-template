# Set up your own Dayline (no coding)

Dayline puts your Notion to-dos, your calendars, your classes and clubs, and your job search on one screen.
You'll get your own private copy, on your own free accounts. Nobody else (including whoever shared this with
you) can see your data.

**Total time: about 30–45 minutes.** Everything here is free. You never need to write code.

| Step | What | Time |
|---|---|---|
| 1 | Make free GitHub and Vercel accounts | 5 min |
| 2 | Click "Deploy" to make your copy | 5 min |
| 3 | Make a Notion integration and connect one page | 5–10 min |
| 4 | Run First-time setup (creates your databases) | 5 min |
| 5 | Add your calendars (secret iCal links) | 5–15 min |
| 6 | Your password | 1 min |
| 7 | Add Dayline to your phone's Home Screen | 2 min |

Menus in GitHub, Notion and Vercel move around now and then. If a button has a slightly different name, look for
the closest match, or see "Stuck? Use an AI helper" at the end.

---

## Step 1. Free GitHub and Vercel accounts (5 min)

1. **GitHub** (stores your copy of the code): go to **github.com**, click **Sign up**, and follow the steps.
   The free plan is all you need.
2. **Vercel** (runs your Dayline website): go to **vercel.com/signup**. Choose the free **Hobby** plan and
   **Continue with GitHub**, so the two accounts are linked.

## Step 2. Make your copy and deploy it (5 min)

Before you start, think of a **password** for Dayline (at least 10 characters). You'll type it whenever you open
Dayline. Use a new one, not a password you use anywhere else.

1. Open the template page: **github.com/laicharmaine/dayline-template**
2. In the README, click the black **Deploy with Vercel** button.
3. Vercel asks you to create a Git repository. Keep the name (e.g. `dayline`). Making it **private** is a good idea.
4. Vercel asks for two **environment variables**:
   - `APP_PASSWORD`: the password you just picked.
   - `NOTION_TOKEN`: you don't have this yet. Do **Step 3, part A** in another tab, then come back and paste it.
5. Click **Deploy** and wait a minute or two. When it's done, Vercel shows your site address, something like
   `https://dayline-yourname.vercel.app`. Bookmark it.

> Prefer GitHub first? On the template page click **Use this template › Create a new repository**, then in Vercel
> click **Add New… › Project**, import that repository, add the same two variables, and **Deploy**.

## Step 3. Notion: make an integration and connect a page (5–10 min)

An "integration" is a key that lets Dayline read and write the Notion pages you choose, and nothing else.

**A. Make the integration**
1. Go to **notion.so/profile/integrations** (signed in to Notion on a computer).
2. Click **New integration** (it may say **+ New integration** or **Create new integration**).
3. Name it `Dayline`, pick your workspace, and keep the type **Internal**. Save.
4. On the integration's page, find **Internal Integration Secret** and click **Show** then **Copy**.
   It starts with `ntn_`. This is your `NOTION_TOKEN`. Treat it like a password: don't post or share it.
5. Make sure its capabilities include reading, updating and inserting content (they're on by default).

**B. Make a home page for Dayline and connect it**
1. In Notion, create a new, empty page, e.g. **"Dayline"**. Dayline will put its six databases inside it.
2. On that page, click **•••** (top right) › **Connections** (sometimes **Add connections**), search for
   `Dayline`, and confirm.
   - If you don't see Connections there, go back to the integration settings page and look for an
     **Access** tab where you can pick which pages it can use. Select your Dayline page.

Only pages you connect are visible to Dayline. Your other Notion pages stay private.

## Step 4. Run First-time setup (5 min)

1. Open your Dayline address and sign in with your password. You'll land on **First-time setup**.
2. Step 1 on that page shows ✓ if your token is already in Vercel. (If not, paste it there.)
3. Click **Show pages I shared** and pick your **Dayline** page (or paste the page's link: in Notion,
   **•••** › **Copy link**).
4. Click **Create my databases**. In about 30 seconds you'll have six new databases under that page:
   To Do, Recruiting pipeline, Brainstorm, People, Touch points and App data (all named "Dayline · …").
5. The page shows a box of settings like `NOTION_DATA_SOURCE_ID=…`. Click **Copy all**.
6. In Vercel: open your project › **Settings** › **Environment Variables**.
   - Add each line as a new variable: the name is the part before `=`, the value is the part after.
   - Tip: Vercel usually lets you paste all the lines at once into the first **Key** box and fills in the
     rest. If that doesn't happen, add them one by one.
   - Save.
7. **Redeploy** so the new settings take effect: **Deployments** tab › the **•••** next to the newest one ›
   **Redeploy**.
8. Open your Dayline again. You should now see the **Today** page. 🎉

It's safe to click **Create my databases** twice; it reuses what it already made under that page.
If you lose the settings box, open `/setup` on your site again and click **I already did this · find them**.

## Step 5. Add your calendars (5–15 min, optional)

Dayline reads calendars through their **secret iCal link** (an address ending in `.ics`). It only reads them;
it never changes your calendars.

**Google Calendar** (on a computer)
1. calendar.google.com › gear icon › **Settings**.
2. On the left, under **Settings for my calendars**, click the calendar.
3. Scroll to **Integrate calendar** and copy **Secret address in iCal format**.
4. Repeat for each calendar you want (e.g. personal, school account).

**Outlook / Microsoft 365**
1. Outlook on the web › gear icon › **Settings** › **Calendar** › **Shared calendars**.
2. Under **Publish a calendar**, choose the calendar and **Can view all details**, then **Publish**.
3. Copy the **ICS** link. (Some school or work accounts turn publishing off. If so, skip it.)

**Canvas**
1. In Canvas, open **Calendar** (left menu).
2. Click **Calendar Feed** (bottom right) and copy the link.

**Partiful and other apps**: look for an option like "Sync to calendar" or "Subscribe" and copy the link that
starts with `webcal://` or `https://` (Dayline handles both). If you already add those events to Google
Calendar, you're covered by that calendar.

**Add them to Vercel** (Settings › Environment Variables), numbered 1, 2, 3…:

| Name | Value |
|---|---|
| `CAL_1_URL` | your first secret link |
| `CAL_1_LABEL` | a friendly name, e.g. `Personal` |
| `CAL_1_GROUP` | `personal`, `school` or `social` |
| `CAL_2_URL`, `CAL_2_LABEL`, `CAL_2_GROUP` | the next calendar… |

For a Canvas feed also add `CAL_n_KIND` = `canvas`. Then **Redeploy** (as in Step 4).

The group sets the color and where events show up (Socializing uses `social`). If you leave out the group,
Dayline guesses from the label.

Secret links are like passwords: anyone with one can see that calendar. Only paste them into Vercel. If one
leaks, Google lets you **Reset** it on the same settings screen.

## Step 6. Your password (1 min)

You set it in Step 2 (`APP_PASSWORD`). To change it: Vercel › Settings › Environment Variables ›
`APP_PASSWORD` › edit, then Redeploy. Changing it signs out every device.

## Step 7. Add to your phone's Home Screen (2 min)

- **iPhone**: open your Dayline address in **Safari** › **Share** button › **Add to Home Screen**.
- **Android**: open it in **Chrome** › **⋮** menu › **Add to Home screen** (or **Install app**).

It opens full-screen like an app. Sign in once and it remembers you.

---

## Make it yours (optional)

- **Your name** on thank-you drafts: add `OWNER_NAME` (e.g. `Alex`) and, if you like, `OWNER_ABOUT`
  (e.g. `a business school student recruiting for product roles`). Redeploy.
- **Time zone**: add `APP_TIMEZONE`, e.g. `America/New_York` or `America/Los_Angeles` (default is US Central).
- **Your classes and clubs**: on GitHub, open your copy › `config/classes.js` › pencil icon (Edit). Replace the
  examples (`Class A`, `Class B`, `Club B`) with your own, keeping the same format, then **Commit changes**.
  Vercel redeploys by itself in a minute. Then in Notion, add the same names as options in the To Do database's
  **Class / Activity** column (setup only created the ones that were in the file at the time).
  Tip: if you edit `config/classes.js` *before* Step 4, setup creates your real classes for you.
- **Your resume** (for job tips): edit `config/resume-baseline.json` the same way, replacing the example bullets.
- **Smarter job parsing and drafts**: get a free key at **aistudio.google.com** (Get API key), add it as
  `GEMINI_API_KEY`, and redeploy.
- Don't need a feature? Add `JOBS_ENABLED=false`, `NETWORK_ENABLED=false` or `BRAINSTORM_ENABLED=false`.

## What each tab does

- **Today**: overdue and upcoming tasks, today's schedule, upcoming deadlines.
- **Week**: 7-day calendar with events, deadlines and tasks.
- **Tasks**: your Notion To Do list, editable right in the table.
- **Jobs**: board of roles you're pursuing: Interested › Applied › Interview › Offer.
- **Opportunities**: roles you're still researching, sorted by fit or deadline.
- **Classes**: one card per class or club with its tasks, sessions and Canvas deadlines, plus sticky notes.
- **Socializing**: social events and your free lunch/dinner slots this week.
- **Coffee chats**: people you've met, every conversation, and thank-you reminders and drafts.
- **+ Add job › Add from URL**: paste a job link and Dayline fills in the details for you to check.

Everything you change in Dayline is saved to your Notion, so you can also edit there.

## Troubleshooting

| What you see | What to do |
|---|---|
| "Dayline is not set up yet" listing missing settings | Add the named variables in Vercel › Settings › Environment Variables, then Redeploy. |
| `APP_PASSWORD should be at least 10 characters` | Use a longer password (or add `ALLOW_SHORT_PASSWORD=true`). Redeploy. |
| Setup says **the token is wrong or was revoked** | Copy the Internal Integration Secret again (Step 3A). Check there's no space at the start or end. |
| Setup says **share that page with your integration** / your page isn't in the list | Do Step 3B again on that exact page (••• › Connections › Dayline). |
| You changed settings but nothing changed | Vercel only uses new settings after a **Redeploy** (Deployments › ••• › Redeploy). |
| Still sent to First-time setup after pasting | `NOTION_DATA_SOURCE_ID` is missing or misspelled in Vercel, or you didn't redeploy. |
| A calendar doesn't show | Use the *secret* iCal link (not the public or normal one), check `CAL_n_URL` numbering, and Redeploy. Calendars refresh every 5 minutes; the ↻ Refresh button forces it. |
| Wrong times | Set `APP_TIMEZONE` to your time zone and Redeploy. |
| "Unknown class / activity" when tagging a task | Add the class as an option in Notion's To Do › Class / Activity column, matching `config/classes.js` exactly. |
| Forgot the password | Set a new `APP_PASSWORD` in Vercel and Redeploy. |
| Deleted a Dayline database by accident | Restore it from Notion's Trash, or run setup again (it creates whatever is missing) and paste the new settings. |

## Stuck? Use an AI helper

If you use Grok Bot, ChatGPT, Claude or another assistant, paste this in, then describe what you see
(screenshots help). **Never paste your password, Notion token or secret calendar links into a chat.**

```
I'm setting up "Dayline", a personal planner web app, from the GitHub template
laicharmaine/dayline-template. I am not a programmer, so please give me one step at a time,
tell me exactly what to click, and wait for me to say "done" before the next step.

How it works: it deploys free to Vercel (Hobby plan) from my own GitHub copy. It needs two
Vercel environment variables to start: APP_PASSWORD (10+ characters) and NOTION_TOKEN (a Notion
"internal integration" secret starting with ntn_). After deploying, I sign in and open /setup,
pick a Notion page I've connected to the integration (page ••• > Connections), and it creates six
Notion databases and shows lines like NOTION_DATA_SOURCE_ID=... that I paste into Vercel >
Settings > Environment Variables, then Redeploy. Calendars are optional: CAL_1_URL / CAL_1_LABEL /
CAL_1_GROUP (personal, school or social) with each calendar's secret iCal (.ics) link, plus
CAL_n_KIND=canvas for Canvas. Every settings change needs a Redeploy. The full guide is SETUP.md
in the repo.

Never ask me to paste my password, Notion token or calendar links into this chat.

Where I am now: [describe the step and what you see]
```

If your assistant can browse the web, you can also point it at the SETUP.md page in your own copy.
