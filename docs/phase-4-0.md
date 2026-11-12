# Phase 4.0

The app now asks who is using it. Sign-in is a hosted Supabase project. Google is the button on a centered page, and the session is a cookie the server checks. There is no local Supabase CLI. The daemon is unchanged and does not see the session. Bots stay on this computer, shared by whoever is signed in here. After sign-in, `/` opens the first bot, the same as before. Nothing stores a last bot.

`pnpm dev` shows an email and password form under the Google button. Fill it with `BINDU_DEV_EMAIL` and `BINDU_DEV_PASS`. The app also reads `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` (the publishable key, not the anon key). Do not print those values. `next start` hides the email form. Do not click through Google.

An unsigned person sees that page. `/bots/<id>` sends them back to it. `/api` routes answer 401. The account icon is at the bottom left of the sidebar. Its menu opens upward and signs this browser out.

`supabase/migrations/20261112160000_profiles.sql` is the profiles table: one row per account, and a select policy so a user can read only their own row. A new account gets its row from a trigger. Applying that file to the hosted project needs a database credential, which this environment does not have, so the table is not there yet. A second hosted session also could not be opened with the publishable key, because a new email is not confirmed. The policy test runs the migration in Postgres as two roles and checks that the second cannot read the first.

The scripted chat tests sign in with the dev account when the keys are present. A build with no keys still opens the app for those tests, so CI can run without the project.

```bash
pnpm test
pnpm e2e
```
