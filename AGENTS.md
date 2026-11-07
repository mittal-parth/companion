# Basic Rules

- Do not create unnecessary single helper files. Try to keep it in an existing file if it already exists. Create a new file when the separation of concern is clear.
- Do not create single use helpers. Do not create too much abstraction. Create a helper if the method has multiple usages or could be meaningfully used in future.
- Keep types in a common file. You can create multiple files for types but all types should be kept centrally.
- Verification via unit tests, e2e tests or evals for each change is important. Consider it done only after typechecks and running tests either by adding new tests, running existing tests or by performing the same via the browser / equivalent as an agent.
- Have doc comments for methods and files focused on the purpose of the method. Don't focus too much on the technical tid bits but rather the purpose of the method.
- Inline comments explaining the change at important points in the method are welcome. However, don't add incremental comments explaining the diff that just happened in that change. Remember, focus is on the overall purpose.
