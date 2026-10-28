// The DIAL server advertises "Application-URL: http://…/ytcr/apps" without the trailing slash that
// Chromecasts and TVs send ("…/apps/"). Phones build the app URL from that header, some adding a
// slash themselves and some not, so advertise "…/apps/" and collapse a doubled slash in request paths.
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const MARK = '/* home-cast patched */';
const file = createRequire(import.meta.url).resolve('@patrickkfkan/peer-dial/lib/peer-dial.js');
let src = readFileSync(file, 'utf8');
if (src.includes(MARK)) process.exit(0);

const header = `rsp.setHeader('Application-URL', baseURL+"/apps");`;
const routes = `app.use(pref+"/apps", cors(self.corsOptionsAppsDelegate));`;
if (!src.includes(header) || !src.includes(routes)) {
  console.error('patch-peer-dial: peer-dial changed, patch not applied');
  process.exit(1);
}

// Path only; the query string is left alone.
const collapse = [
  'app.use(function(req, rsp, next){',
  "var q = req.url.indexOf('?'); var p = q < 0 ? req.url : req.url.slice(0, q);",
  "while (p.indexOf('//') >= 0) p = p.replace('//', '/');",
  "req.url = p + (q < 0 ? '' : req.url.slice(q)); next(); });",
].join(' ');

src = src
  .replace(header, () => `rsp.setHeader('Application-URL', baseURL+"/apps/");`)
  .replace(routes, () => `${collapse} ${MARK}\n\t${routes}`);
writeFileSync(file, src);
console.log('patch-peer-dial: applied');
