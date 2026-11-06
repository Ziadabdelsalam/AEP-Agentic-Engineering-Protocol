#!/usr/bin/env node
// The aep command: what a person runs to set up this machine and opt repos in.
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

import { git, groupIdFor, normalizeRemote, webUrlFor } from '../lib/git.js';
import { hubRequest } from '../lib/hub-client.js';
import {
  aepHome,
  findRepo,
  helperEnv,
  isProcessAlive,
  loadConfig,
  loadRepoConfig,
  loadRepos,
  loadTrustedKeys,
  readJson,
  repoStateDir,
  saveConfig,
  saveRepoConfig,
  saveRepos,
  saveTrustedKeys,
  writeJson,
} from '../lib/local.js';
import { keyId } from '../lib/protocol.js';

const HELP = `aep: Agentic Engineering Protocol

Set up this machine
  aep signup --hub <url> --name <you> --code <code>   Create your account, or add this machine with a device code
  aep pair-browser [--yes]                            Trust a browser or phone to sign in and send commands
  aep device-code                                     Get a code to add another machine

Opt a repo in (run inside the repo)
  aep join [--invite <code>]                          Join or create this repo's group
  aep invite                                          Invite someone to this repo's group
  aep leave                                           Stop sharing this repo
  aep workers enable [--model <m>] [--budget <usd>] [--minutes <n>] [--turns <n>] [--allow <tool>]...
  aep workers disable

Status
  aep status                                          Show this machine's setup
  aep helper start|stop|status                        Control the local helper
  aep helper install|uninstall                        Keep the helper running across restarts
`;

class CliError extends Error {}

function parseFlags(args) {
  const flags = { _: [] };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith('--')) {
      flags._.push(arg);
      continue;
    }
    const key = arg.slice(2);
    const next = args[index + 1];
    const value = next === undefined || next.startsWith('--') ? true : (index += 1, next);
    if (flags[key] === undefined) flags[key] = value;
    else flags[key] = [flags[key], value].flat();
  }
  return flags;
}

function requireConfig() {
  const config = loadConfig();
  if (!config) throw new CliError('This machine is not set up yet. Run: aep signup --hub <url> --name <you> --code <code>');
  return config;
}

function requireRepo() {
  const repo = findRepo(process.cwd());
  if (!repo) throw new CliError('Run this inside a git repo.');
  return repo;
}

function requireJoinedRepo() {
  const repo = requireRepo();
  const stateDir = repoStateDir(repo.commonDir);
  const repoConfig = loadRepoConfig(stateDir);
  if (!repoConfig) throw new CliError("This repo hasn't joined a group. Run: aep join");
  return { repo, stateDir, repoConfig };
}

const helperScript = () => path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'helper', 'aepd.js');
const helperPid = () => {
  const pid = readJson(path.join(aepHome(), 'helper.json'))?.pid;
  return isProcessAlive(pid) ? pid : null;
};

function startHelper() {
  if (helperPid()) return false;
  const child = spawn(process.execPath, [helperScript()], { detached: true, stdio: 'ignore', env: helperEnv() });
  child.unref();
  return true;
}

const commands = {
  async signup(flags) {
    if (typeof flags.hub !== 'string' || typeof flags.code !== 'string') {
      throw new CliError('Usage: aep signup --hub <url> --name <you> --code <code>');
    }
    if (loadConfig() && !flags.force) throw new CliError(`This machine is already set up as ${loadConfig().person}. Pass --force to replace that.`);
    const hub = flags.hub.replace(/\/+$/, '');
    const device = typeof flags.device === 'string' ? flags.device : os.hostname().split('.')[0].replace(/[^\w.-]/g, '-');
    const data = await hubRequest({ hub }, 'POST', '/v1/signup', { name: flags.name, code: flags.code, device });
    saveConfig({ hub, person: data.person, device: data.device.name, token: data.token });
    console.log(`Signed up as ${data.person} on ${data.device.name}. Next, run this in a repo: aep join`);
  },

  async 'device-code'() {
    const config = requireConfig();
    const { code } = await hubRequest(config, 'POST', '/v1/devices/codes');
    console.log(`Run this on the other machine within 10 minutes:\n\n  aep signup --hub ${config.hub} --code ${code}\n`);
  },

  async join(flags) {
    const config = requireConfig();
    const repo = requireRepo();
    const remote = git(repo.root, ['remote', 'get-url', 'origin']);
    if (!remote.ok) throw new CliError('This repo has no origin remote, so there is nothing to share a group around.');
    const normalized = normalizeRemote(remote.stdout);
    const group = groupIdFor(normalized);
    const name = path.basename(normalized);
    const webUrl = webUrlFor(normalized);
    const result = await hubRequest(config, 'POST', '/v1/groups', {
      id: group,
      name,
      ...(webUrl ? { web_url: webUrl } : {}),
      ...(typeof flags.invite === 'string' ? { invite: flags.invite } : {}),
    });
    const latest = await hubRequest(config, 'GET', `/v1/groups/${group}/messages?limit=1`);
    const stateDir = repoStateDir(repo.commonDir);
    const existing = loadRepoConfig(stateDir);
    saveRepoConfig(stateDir, {
      group,
      name,
      web_url: result.group.web_url,
      workers: existing?.workers ?? { enabled: false },
    });
    if (!fs.existsSync(path.join(stateDir, 'helper-state.json'))) {
      writeJson(path.join(stateDir, 'helper-state.json'), { last_seq: latest.messages.at(-1)?.seq ?? 0 });
    }
    const repos = loadRepos();
    if (!repos.repos.some((entry) => entry.common_dir === repo.commonDir)) {
      repos.repos.push({ path: repo.root, common_dir: repo.commonDir, group });
      saveRepos(repos);
    }
    startHelper();
    console.log(`${result.created ? 'Created' : 'Joined'} the group for ${name}. Agents in this repo are now part of it.`);
    if (result.created) console.log('Invite a teammate with: aep invite');
  },

  async invite() {
    const config = requireConfig();
    const { repoConfig } = requireJoinedRepo();
    const { code, expires_at: expiresAt } = await hubRequest(config, 'POST', `/v1/groups/${repoConfig.group}/invites`);
    console.log(`Send this to your teammate. It works once, until ${expiresAt}.

If they're new to this hub, they run this first:
  aep signup --hub ${config.hub} --name <their name> --code ${code}
Then, in their clone of the repo:
  aep join

If they already have an account:
  aep join --invite ${code}
`);
  },

  async leave() {
    const { repo, stateDir } = requireJoinedRepo();
    fs.rmSync(path.join(stateDir, 'repo.json'), { force: true });
    const repos = loadRepos();
    repos.repos = repos.repos.filter((entry) => entry.common_dir !== repo.commonDir);
    saveRepos(repos);
    console.log('This repo no longer shares anything with the group.');
  },

  // The browser proves it holds the secret in the link, which the hub never sees. The helper will
  // only trust a key after that check and after you compare the code on both screens.
  async 'pair-browser'(flags) {
    const config = requireConfig();
    const secret = crypto.randomBytes(32).toString('base64url');
    const { id } = await hubRequest(config, 'POST', '/v1/pairings');
    console.log(`Open this link in the browser or phone you want to pair. It works once, for 10 minutes:\n\n  ${config.hub}/#pair/${id}/${secret}\n\nWaiting for the browser...`);
    const deadline = Date.now() + 10 * 60 * 1000;
    let pairing = null;
    while (Date.now() < deadline) {
      pairing = await hubRequest(config, 'GET', `/v1/pairings/${id}`);
      if (pairing.completed) break;
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
    if (!pairing?.completed) throw new CliError('Timed out waiting for the browser.');
    const expected = crypto.createHmac('sha256', secret)
      .update(JSON.stringify(['aep-pair-v1', id, pairing.jwk.x, pairing.jwk.y]))
      .digest('base64url');
    const provided = Buffer.from(String(pairing.mac));
    if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, Buffer.from(expected))) {
      throw new CliError('The key that came back was not made with this link. Nothing was trusted. Someone may have tampered with it.');
    }
    const kid = keyId(pairing.jwk);
    const code = `${kid.slice(0, 4)}-${kid.slice(4, 8)}`.toUpperCase();
    console.log(`\nThe browser should be showing this code: ${code}`);
    if (!flags.yes) {
      const prompt = readline.createInterface({ input: process.stdin, output: process.stdout });
      const answer = await prompt.question('Does it match? Trust this browser? [y/N] ');
      prompt.close();
      if (!/^y(es)?$/i.test(answer.trim())) throw new CliError('Nothing was trusted.');
    }
    const trusted = loadTrustedKeys();
    if (!trusted.keys.some((entry) => entry.kid === kid)) {
      trusted.keys.push({ kid, jwk: pairing.jwk, label: pairing.label, added_at: new Date().toISOString() });
      saveTrustedKeys(trusted);
    }
    await hubRequest(config, 'POST', `/v1/pairings/${id}/confirm`);
    console.log(`Trusted. That browser can now sign in and send commands to agents on this machine.`);
  },

  async workers(flags) {
    const { stateDir, repoConfig } = requireJoinedRepo();
    const action = flags._[0];
    if (action === 'disable') {
      repoConfig.workers = { ...repoConfig.workers, enabled: false };
      saveRepoConfig(stateDir, repoConfig);
      console.log('Workers are off for this repo. Your commands wait for the agent\'s next run.');
      return;
    }
    if (action !== 'enable') throw new CliError('Usage: aep workers enable|disable');
    const workers = { ...repoConfig.workers, enabled: true };
    if (typeof flags.model === 'string') workers.model = flags.model;
    if (flags.budget) workers.max_budget_usd = Number(flags.budget);
    if (flags.minutes) workers.max_minutes = Number(flags.minutes);
    if (flags.turns) workers.max_turns = Number(flags.turns);
    if (flags.allow) {
      const { DEFAULT_WORKER_LIMITS } = await import('../helper/commands.js');
      workers.allowed_tools = [...DEFAULT_WORKER_LIMITS.allowed_tools, ...[flags.allow].flat()];
    }
    repoConfig.workers = workers;
    saveRepoConfig(stateDir, repoConfig);
    console.log('Workers are on for this repo. A command you sign can now start an agent on this machine, in its own worktree.');
  },

  async helper(flags) {
    const action = flags._[0] ?? 'status';
    const pid = helperPid();
    switch (action) {
      case 'start':
        console.log(startHelper() ? 'Helper started.' : `Helper is already running, pid ${pid}.`);
        return;
      case 'stop':
        if (pid) process.kill(pid, 'SIGTERM');
        console.log(pid ? 'Helper stopped.' : "Helper wasn't running.");
        return;
      case 'status':
        console.log(pid ? `Helper is running, pid ${pid}.` : 'Helper is not running.');
        return;
      case 'install':
        return installHelper();
      case 'uninstall':
        return uninstallHelper();
      default:
        throw new CliError('Usage: aep helper start|stop|status|install|uninstall');
    }
  },

  async status() {
    const config = loadConfig();
    if (!config) return void console.log('Not set up. Run: aep signup --hub <url> --name <you> --code <code>');
    console.log(`Hub:     ${config.hub}\nYou:     ${config.person} on ${config.device}`);
    const pid = helperPid();
    console.log(`Helper:  ${pid ? `running, pid ${pid}` : 'not running'}`);
    console.log(`Trusted browsers: ${loadTrustedKeys().keys.length}`);
    const repos = loadRepos().repos;
    console.log(`Repos:   ${repos.length}`);
    for (const entry of repos) {
      const repoConfig = loadRepoConfig(repoStateDir(entry.common_dir));
      console.log(`  ${entry.path}\n    group ${repoConfig?.name ?? '?'}, workers ${repoConfig?.workers?.enabled ? 'on' : 'off'}`);
    }
  },
};

// Keeping the helper alive when no session is open is what lets a command start a worker.

const launchAgentFile = () => path.join(os.homedir(), 'Library', 'LaunchAgents', 'dev.aep.helper.plist');
const systemdFile = () => path.join(os.homedir(), '.config', 'systemd', 'user', 'aep-helper.service');

function installHelper() {
  if (process.platform === 'darwin') {
    const file = launchAgentFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>dev.aep.helper</string>
  <key>ProgramArguments</key><array><string>${process.execPath}</string><string>${helperScript()}</string></array>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>${process.env.PATH}</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict></plist>
`);
    spawnSync('launchctl', ['load', '-w', file]);
    console.log(`Installed ${file}. The helper now runs whenever you're logged in.`);
    return;
  }
  if (process.platform === 'linux') {
    const file = systemdFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `[Unit]
Description=AEP local helper

[Service]
ExecStart=${process.execPath} ${helperScript()}
Environment=PATH=${process.env.PATH}
Restart=always

[Install]
WantedBy=default.target
`);
    spawnSync('systemctl', ['--user', 'enable', '--now', 'aep-helper.service']);
    console.log(`Installed ${file}. The helper now runs whenever you're logged in.`);
    return;
  }
  throw new CliError('Installing the helper is only supported on macOS and Linux. Run `aep helper start` instead.');
}

function uninstallHelper() {
  if (process.platform === 'darwin') {
    spawnSync('launchctl', ['unload', '-w', launchAgentFile()]);
    fs.rmSync(launchAgentFile(), { force: true });
  } else if (process.platform === 'linux') {
    spawnSync('systemctl', ['--user', 'disable', '--now', 'aep-helper.service']);
    fs.rmSync(systemdFile(), { force: true });
  }
  console.log('Removed the helper from startup.');
}

async function main() {
  const [name, ...rest] = process.argv.slice(2);
  if (!name || name === 'help' || name === '--help') return void console.log(HELP);
  const command = commands[name];
  if (!command) throw new CliError(`Unknown command ${name}.\n\n${HELP}`);
  await command(parseFlags(rest));
}

main().catch((error) => {
  console.error(error instanceof CliError ? error.message : `Error: ${error.message}`);
  process.exit(1);
});
