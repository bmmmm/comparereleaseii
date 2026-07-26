#!/usr/bin/env bash
# Create the labels the issue forms and the intake workflow rely on.
# Idempotent — reruns update colour and description in place.
# GitHub silently drops a label an issue template requests but that does not
# exist, so run this once after enabling the templates.
set -euo pipefail

repo="${1:-$(gh repo view --json nameWithOwner -q .nameWithOwner)}"

label() {
  gh label create "$1" --repo "$repo" --color "$2" --description "$3" --force >/dev/null
  printf '  %s\n' "$1"
}

printf 'Labels for %s:\n' "$repo"

# Issue classes
label triage          "ededed" "Not looked at yet"
label wrong-verdict   "b60205" "A claim was ruled incorrectly"
label notes-dialect   "5319e7" "Release-notes format is parsed wrongly"
label engine          "1d76db" "Judge engine or local model server"
label task            "0e8a16" "Specified unit of work, ready to pick up"

# Workflow state
label agent-ready     "c2e0c6" "Fully specified — implementable without follow-up questions"
label needs-repro     "fbca04" "Waiting for a reproduction"
label breaking-change "d93f0b" "Changes exit codes, JSON schema or flag behaviour"

printf 'Done.\n'
