export function writeJson(path, data) {
  try {
    Deno.writeTextFileSync(path, JSON.stringify(data));
    return "Written to " + path;
  } catch (e) {
    return e.message;
  }
}

export function writeFile(path, data) {
  try {
    Deno.writeTextFileSync(path, data);
    return "Written to " + path;
  } catch (e) {
    return e.message;
  }
}
