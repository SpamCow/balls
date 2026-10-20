// Bundles the demo into one HTML file. three.js loads from the CDN as the THREE global.
import { build } from "esbuild";
import fs from "node:fs";
const out = await build({
  entryPoints: ["demo/demo.ts"],
  bundle: true, minify: true, format: "iife", target: "es2020", write: false,
  plugins: [{ name: "three-global", setup(b) {
    b.onResolve({ filter: /^three$/ }, () => ({ path: "three", namespace: "g" }));
    b.onLoad({ filter: /.*/, namespace: "g" }, () => ({ contents: "module.exports = window.THREE", loader: "js" }));
  } }],
});
const js = out.outputFiles[0].text.replace(/<\/script/gi, "<\\/script");
const html = fs.readFileSync("demo/template.html", "utf8").replace("/*BUNDLE*/", () => js);
fs.writeFileSync(process.argv[2] || "demo/dist.html", html);
console.log(`demo: ${(html.length / 1024).toFixed(0)} KB`);
