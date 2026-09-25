# WAYFINDER Engineering System

This repository is the source of truth for WAYFINDER development. Chat transcripts and traveler ZIPs are not source control.

## Status

The imported baseline is **DEVELOPMENT / UNVERIFIED**. It is not a release.

## Hard rule

A traveler release may only come from the `release.yml` GitHub Actions workflow. Developers and assistants must not hand-package a traveler ZIP.

## Gate layers

1. `development.yml` — fast source gates on every push / pull request.
2. `rendered.yml` — Chromium rendered acceptance and canonical hostile matrix.
3. `release.yml` — manual frozen-candidate pipeline on Windows. It runs source gates, rendered gates, creates an exact candidate, proves native Windows lifecycle against that candidate, then runs the Release Manager gate. Only after all of those pass may it upload a traveler artifact.

The release workflow is intentionally expected to refuse this initial baseline while `RELEASE.json` remains `unverified`.
