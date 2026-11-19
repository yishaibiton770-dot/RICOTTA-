const { mkdirSync, copyFileSync } = require("node:fs");

mkdirSync("public", { recursive: true });
for (const file of ["index.html", "admin.html", "admin.css", "admin.js", "success.html"]) {
  copyFileSync(file, "public/" + file);
}
