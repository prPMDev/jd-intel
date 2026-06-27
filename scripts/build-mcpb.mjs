#!/usr/bin/env node
/**
 * Build the jd-intel MCPB bundle -> dist/jd-intel.mcpb
 *
 * Produces a self-contained .mcpb from the mcp/ server + production deps + a
 * generated manifest. The jd-intel library is bundled from THIS repo (via
 * `npm pack`), not the npm registry, so the bundle always matches the code
 * being released and the build works before the version is published.
 *
 * Usage: npm run pack:mcpb
 */
import { rm, mkdir, copyFile, readFile, writeFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MCP = join(ROOT, 'mcp');
const DIST = join(ROOT, 'dist');
const BUILD = join(DIST, 'mcpb-build');
const MCPB = '@anthropic-ai/mcpb@2.1.2'; // pinned for reproducible builds

// execSync with a string runs through a shell, so `npm`/`npx` resolve to
// npm.cmd/npx.cmd on Windows and npm/npx on Linux (CI) without extra handling.
const sh = (cmd, cwd = ROOT) => execSync(cmd, { cwd, stdio: 'inherit' });
const q = (p) => `"${p.replace(/\\/g, '/')}"`; // quoted, forward-slash path

async function main() {
  const mcpPkg = JSON.parse(await readFile(join(MCP, 'package.json'), 'utf-8'));

  // 1. Clean staging
  await rm(DIST, { recursive: true, force: true });
  await mkdir(BUILD, { recursive: true });

  // 2. Copy the server files (mcp package `files` + package.json). No tests,
  //    no node_modules (installed fresh below).
  for (const f of [...mcpPkg.files, 'package.json']) {
    if (existsSync(join(MCP, f))) await copyFile(join(MCP, f), join(BUILD, f));
  }

  // Bundle the project icon if present. It lives at the repo root (docs/),
  // not in mcp/files, so the loop above does not pick it up.
  const hasIcon = existsSync(join(ROOT, 'docs', 'icon.png'));
  if (hasIcon) await copyFile(join(ROOT, 'docs', 'icon.png'), join(BUILD, 'icon.png'));

  // 3. Pack the local library so the bundle carries THIS repo's jd-intel
  //    (a real copy via tarball, not a symlink; works pre-publish).
  sh(`npm pack --pack-destination ${q(DIST)}`, ROOT);
  const tgz = (await readdir(DIST)).find((f) => f.startsWith('jd-intel-') && f.endsWith('.tgz'));
  if (!tgz) throw new Error('npm pack did not produce a jd-intel tarball');

  // 4. Point the staging dep at the packed tarball, then install prod deps
  //    (SDK + zod from the registry, jd-intel from the tarball).
  const stagingPkg = JSON.parse(await readFile(join(BUILD, 'package.json'), 'utf-8'));
  stagingPkg.dependencies['jd-intel'] = `file:../${tgz}`;
  await writeFile(join(BUILD, 'package.json'), JSON.stringify(stagingPkg, null, 2) + '\n');
  sh('npm install --omit=dev --no-audit --no-fund', BUILD);

  // 5. Generate the manifest (version/desc from the mcp package = single
  //    source of truth, so the bundle version can never drift).
  const author = {
    name: typeof mcpPkg.author === 'string' ? mcpPkg.author : mcpPkg.author.name,
    url: 'https://prashantrana.xyz',
  };
  // Honest, plain-language access disclosure. Verified against the code: the
  // server reads no user files and runs no commands; it only fetches public
  // job-board APIs. This cannot remove Claude Desktop's generic warnings, but
  // it states the truth next to them.
  const longDescription = [
    'jd-intel gives your AI assistant direct access to live job postings across seven applicant tracking systems: Greenhouse, Lever, Ashby, SmartRecruiters, Teamtailor, Recruitee, and Workday. It reads available job listings to find roles, filter by title and location, and pull full descriptions, no copy-paste.',
    'What it can access: it makes outbound HTTPS requests to public job-board APIs to read publicly listed postings, plus one request to refresh its own hosted company list. It does not read your personal files, does not run commands on your computer, and writes nothing to your disk. The only file it reads is its own bundled list of companies. It sends only the company names and search terms needed to look up postings, never your resume, identity, or any personal data.',
    'Open source (MIT). Source and issues: https://github.com/prPMDev/jd-intel',
  ].join('\n\n');
  const manifest = {
    manifest_version: '0.2',
    name: mcpPkg.name,
    display_name: 'JD Intel',
    version: mcpPkg.version,
    description: mcpPkg.description,
    author,
    homepage: mcpPkg.homepage,
    documentation: 'https://prpmdev.github.io/jd-intel/',
    repository: { type: 'git', url: mcpPkg.repository?.url },
    license: mcpPkg.license,
    support: 'https://github.com/prPMDev/jd-intel/issues',
    long_description: longDescription,
    ...(hasIcon ? { icon: 'icon.png' } : {}),
    server: {
      type: 'node',
      entry_point: 'server.js',
      mcp_config: { command: 'node', args: ['${__dirname}/server.js'], env: {} },
    },
    tools: [
      { name: 'fetch_jobs', description: "Fetch a company's open roles from its hiring system" },
      { name: 'search_registry', description: 'Find supported companies by name or sector' },
      { name: 'detect_ats', description: 'Identify which hiring platform a company uses' },
    ],
    compatibility: {
      runtimes: { node: '>=18.0.0' },
      platforms: ['darwin', 'win32', 'linux'],
    },
    keywords: ['jobs', 'job-description', 'ats', 'mcp', 'claude', 'greenhouse', 'lever', 'ashby'],
  };
  await writeFile(join(BUILD, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

  // 6. Validate + pack
  sh(`npx -y ${MCPB} validate ${q(join(BUILD, 'manifest.json'))}`, ROOT);
  const out = join(DIST, 'jd-intel.mcpb');
  sh(`npx -y ${MCPB} pack ${q(BUILD)} ${q(out)}`, ROOT);
  console.log(`\nBuilt ${out.replace(/\\/g, '/')}`);
}

main().catch((err) => {
  console.error('build-mcpb failed:', err.message);
  process.exit(1);
});
