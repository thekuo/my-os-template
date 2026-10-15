// Applies our native changes on top of the project that `npx cap add android` generates (android/android/).
// Run in CI after `cap add` and before `cap sync`. Fails loudly if the template changed under us.
import { cpSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const native = join(root, 'android');
const app = join(native, 'app');
if (!existsSync(app)) throw new Error('android/android/app missing: run `npx cap add android` first');

// 1. Overlay: manifest, MainActivity + shell plugin, icon, splash, theme, injected shell JS
cpSync(join(root, 'overlay', 'app'), app, { recursive: true, force: true });

// 2. Version from CI (versionCode must grow for Android to accept an update over the installed APK)
const gradlePath = join(app, 'build.gradle');
let gradle = readFileSync(gradlePath, 'utf8');
const code = process.env.MYOS_VERSION_CODE || '1';
const name = process.env.MYOS_VERSION_NAME || '1.0.0-local';
const before = gradle;
gradle = gradle.replace(/versionCode\s+\d+/, `versionCode ${code}`).replace(/versionName\s+"[^"]*"/, `versionName "${name}"`);
if (gradle === before) throw new Error('could not set versionCode/versionName in app/build.gradle');

// 3. Dependencies MainActivity uses directly
const deps = [];
if (!/core-splashscreen/.test(gradle)) deps.push('implementation "androidx.core:core-splashscreen:1.0.1"');
if (!/androidx\.webkit:webkit/.test(gradle)) deps.push('implementation "androidx.webkit:webkit:1.12.1"'); // document-start script
if (!/androidx\.work:work-runtime/.test(gradle)) deps.push('implementation "androidx.work:work-runtime:2.9.1"'); // widget refresh
if (deps.length) gradle += `\ndependencies {\n    ${deps.join('\n    ')}\n}\n`;
writeFileSync(gradlePath, gradle);

console.log(`prepare-native: overlay applied, version ${name} (${code})${deps.length ? ', added ' + deps.join(', ') : ''}`);
