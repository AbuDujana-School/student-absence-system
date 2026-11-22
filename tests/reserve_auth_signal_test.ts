const source = await Deno.readTextFile(new URL("../reserve-workflow.js", import.meta.url));

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

Deno.test("reserve workflow wrappers preserve app authentication abort signals", () => {
  const wrappers = source.match(
    /(?:window\.appAuthRequest|const wrappedRequest)=async function\(body,token,signal\)/g,
  ) || [];
  assert(wrappers.length === 3, "All three reserve wrappers must accept the third signal argument");

  const forwarded = source.match(/originalRequest\.call\(this,body,token,signal\)/g) || [];
  assert(forwarded.length === 3, "All three reserve wrappers must forward the abort signal to the wrapped request");

  assert(
    !/originalRequest\.call\(this,body,token\)/.test(source),
    "No reserve wrapper may drop the abort signal",
  );
});
