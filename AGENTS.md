# Basic Rules

- Do not create a file per helper. A few related helpers belong in one file. Keep a helper in an existing file when it already has a home. Create a new file when the separation of concern is clear, and put the related helpers in that one file.
- Do not create single use helpers. Do not create too much abstraction. Create a helper if the method has multiple usages or could be meaningfully used in future.
- Keep types in a common file. You can create multiple files for types but all types should be kept centrally.
- Verification via unit tests, e2e tests or evals for each change is important. Consider it done only after typechecks and running tests either by adding new tests, running existing tests or by performing the same via the browser / equivalent as an agent.
- Have doc comments for methods and files focused on the purpose of the method. Don't focus too much on the technical tid bits but rather the purpose of the method.
- Inline comments explaining the change at important points in the method are welcome. However, don't add incremental comments explaining the diff that just happened in that change. Remember, focus is on the overall purpose.
- Prefer existing, maintained components and libraries (AI Elements, shadcn, the AI SDK) over writing our own, and customise them only lightly.

## Signing in

The app is closed until someone is signed in. Google is the button on the sign-in page. Do not run that flow.

`pnpm dev` also shows an email and password form under that button. Fill it with `BINDU_DEV_EMAIL` and `BINDU_DEV_PASS`. The app reads `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`. Do not print any of those values. A production build does not show the email form.

After sign-in, `/` opens the first bot on this computer. Sign out is the account icon at the bottom left of the sidebar.

## Pull request media

Cite a screenshot as a markdown image, and a recording as `<video src="/opt/cursor/artifacts/<name>.mp4"></video>`. The file must already be under `/opt/cursor/artifacts/`. Update the pull request body through the pull-request tool so it uploads the file.

For a recording, the tool rewrites that video tag into a poster image linked to the agent artifacts page. That poster is the attachment. Leave the rewrite as the tool wrote it.

Do not:

- Copy or rename the mp4, including to `.bin`, and cite that copy. GitHub serves the copy as a file download.
- Hand-write a cursor.com URL, an `artifacts/c/art-...` URL, or a link to the agent artifacts page. A URL you type does not attach the file.
- Replace the tool's poster with a download link, a markdown link to the file, or a video tag whose src is a URL.
- Cite a recording as an image, or a screenshot as a video, to get around the rewrite.
