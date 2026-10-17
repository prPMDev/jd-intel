# Privacy policy

jd-intel is a toolkit that fetches public job postings for your AI assistant. This policy covers the `jd-intel` library and CLI, the `jd-intel-mcp` server, and the jd-intel plugin for Claude.

## What runs where

Everything runs on your own machine. There is no jd-intel account and no jd-intel server. When you ask your AI about jobs, the software on your computer calls the public job-board API of the hiring platform that hosts the company's board (Greenhouse, Lever, Ashby, SmartRecruiters, Teamtailor, Recruitee, Personio, Workable or Workday) and fetches the company registry from `https://prpmdev.github.io/jd-intel/registry/`, a static file on GitHub Pages.

## What we collect

Nothing. Your questions, the companies you look up and the postings you read are never sent to us. We do not run analytics inside the toolkit and we have no way to see who uses it.

## What third parties see

The hiring platforms see ordinary API requests from your computer, the same as a browser visiting the board would make. GitHub Pages serves the registry file and sees the request for it, under GitHub's own privacy terms. No request carries your identity, your questions or your AI conversation.

## Retention

The toolkit stores nothing on disk and keeps nothing between calls. The registry file is cached in memory for the life of the process only.

## Changes and contact

This policy changes only when the software's behaviour does, and the change is recorded in the repository history. Questions: open an issue at https://github.com/prPMDev/jd-intel/issues.
