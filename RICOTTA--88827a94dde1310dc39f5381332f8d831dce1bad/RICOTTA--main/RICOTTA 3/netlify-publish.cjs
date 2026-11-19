const { mkdirSync, copyFileSync, cpSync } = require("node:fs");

mkdirSync("public", { recursive: true });
for (const file of ["index.html", "admin.html", "admin.css", "admin.js", "success.html", "ricotta-media.js", "storefront-icons.svg"]) {
  copyFileSync(file, "public/" + file);
}
cpSync("assets", "public/assets", { recursive: true });
