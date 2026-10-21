'use strict';
/* ================================================
   Set the admin credentials.
     npm run admin:password                       → prompts for a password (hidden), writes .env
     npm run admin:password -- --generate         → creates a strong random password
     npm run admin:password -- --totp             → also creates a two-factor (authenticator) secret
     npm run admin:password -- --generate --totp --print-env
                                                  → doesn't touch .env; prints the values to paste
                                                    into Vercel / your host's environment settings
   Only the scrypt hash and the TOTP secret are stored/printed for config.
   The plain password is shown once and never written to disk unless --out <file> is given
   (delete that file after reading).
   ================================================ */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const readline = require('node:readline');
const { hashPassword, generateTotpSecret } = require('../server/admin/auth');

const ROOT = path.resolve(__dirname, '..');
const ENV = path.join(ROOT, '.env');
const EXAMPLE = path.join(ROOT, '.env.example');
const args = process.argv.slice(2);

function ask(question, hidden) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      rl._writeToOutput = s => { if (s.includes(question)) rl.output.write(s); else rl.output.write('*'); };
    }
    rl.question(question, answer => {
      rl.close();
      if (hidden) process.stdout.write('\n');
      resolve(answer);
    });
  });
}

function setEnvVar(content, key, value) {
  const line = `${key}='${value}'`;
  const re = new RegExp(`^${key}=.*$`, 'm');
  return re.test(content) ? content.replace(re, () => line) : content.replace(/\n?$/, '\n') + line + '\n';
}

(async () => {
  let password;
  if (args.includes('--generate')) {
    password = crypto.randomBytes(18).toString('base64url');
  } else {
    password = await ask('New admin password (min 12 chars): ', true);
    const again = await ask('Repeat password: ', true);
    if (password !== again) {
      console.error('Passwords do not match.');
      process.exit(1);
    }
  }
  if (password.length < 12) {
    console.error('Password must be at least 12 characters.');
    process.exit(1);
  }

  const hash = hashPassword(password);
  const totp = args.includes('--totp') ? generateTotpSecret() : '';
  const printEnv = args.includes('--print-env');

  let user = 'admin';
  if (!printEnv) {
    let env = fs.existsSync(ENV) ? fs.readFileSync(ENV, 'utf8') : fs.readFileSync(EXAMPLE, 'utf8');
    env = setEnvVar(env, 'ADMIN_PASSWORD_HASH', hash);
    if (totp) env = setEnvVar(env, 'ADMIN_TOTP_SECRET', totp);
    fs.writeFileSync(ENV, env, { mode: 0o600 });
    user = (env.match(/^ADMIN_USERNAME=['"]?([^'"\r\n]*)/m) || [])[1] || 'admin';
    console.log('Credentials saved to .env.');
  } else {
    console.log('\nPaste these into your hosting environment variables (they are NOT saved to any file):\n');
    console.log(`ADMIN_USERNAME=${user}`);
    console.log(`ADMIN_PASSWORD_HASH=${hash}`);
    if (totp) console.log(`ADMIN_TOTP_SECRET=${totp}`);
    console.log('');
  }

  const outIdx = args.indexOf('--out');
  if (outIdx !== -1 && args[outIdx + 1]) {
    const out = path.resolve(ROOT, args[outIdx + 1]);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, `Admin portal login (delete this file after saving it in a password manager)\nusername: ${user}\npassword: ${password}\n${totp ? `authenticator secret: ${totp}\n` : ''}`, { mode: 0o600 });
    console.log(`Login details written to ${path.relative(ROOT, out)} — delete it after reading.`);
  } else if (args.includes('--generate') || printEnv) {
    console.log(`Username: ${user}\nPassword: ${password}\n(Shown once — store it in a password manager.)`);
  }
  if (totp) {
    const label = encodeURIComponent(`House of Mangalya Admin:${user}`);
    console.log(`\nTwo-factor: add this to Google Authenticator / Authy / 1Password ("enter a setup key", time-based):\n  ${totp}\n  otpauth://totp/${label}?secret=${totp}&issuer=House%20of%20Mangalya\n(Shown once — keep it safe; anyone with it can generate your codes.)`);
  }
  console.log('Restart the server for changes to take effect.');
})();
