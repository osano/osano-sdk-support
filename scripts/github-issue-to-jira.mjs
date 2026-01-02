import fs from "node:fs";
import { parseIssue } from "@github/issue-parser";

function requiredEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

const ISSUE_TEMPLATE_PATH = requiredEnv("ISSUE_TEMPLATE_PATH");

// Jira
const JIRA_BASE_URL = requiredEnv("JIRA_BASE_URL").replace(/\/$/, "");
const JIRA_EMAIL = requiredEnv("JIRA_EMAIL");
const JIRA_API_TOKEN = requiredEnv("JIRA_API_TOKEN");
const JIRA_PROJECT_KEY = process.env.JIRA_PROJECT_KEY ?? "SDK";
const JIRA_ISSUE_TYPE = process.env.JIRA_ISSUE_TYPE ?? "Bug";

// GitHub
const GITHUB_TOKEN = requiredEnv("GITHUB_TOKEN");
const GH_EVENT = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
const issue = GH_EVENT.issue;

if (!issue) throw new Error("No issue in event payload.");

const repoFull = process.env.GITHUB_REPOSITORY; // owner/repo
const [owner, repo] = repoFull.split("/");

const issueNumber = issue.number;
const issueTitle = issue.title ?? "";
const issueBody = issue.body ?? "";
const issueUrl = issue.html_url ?? "";
const issueAuthor = issue.user?.login ?? "unknown";

// GitHub labels
const ghLabels = (issue.labels ?? []).map(l => l.name).filter(Boolean);

// Load template YAML and parse issue form -> field IDs
const templateYaml = fs.readFileSync(ISSUE_TEMPLATE_PATH, "utf8");

// parseIssue will match field IDs if template is provided (preferred) :contentReference[oaicite:3]{index=3}
const form = parseIssue(issueBody, templateYaml);

// Field IDs from your template
const FIELD_IDS = [
  "severity",
  "sdk-version",
  "sdk-version-other",
  "android-version",
  "device",
  "gradle-version",
  "kotlin-version",
  "steps-to-reproduce",
  "expected-behavior",
  "actual-behavior",
  "logs",
  "additional-context",
  "confirmations",
];

// Helpers
function isMissing(v) {
  if (v === undefined || v === null) return true;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === "string") return v.trim().length === 0;
  if (typeof v === "object") {
    // checkboxes shape: { selected: [], unselected: [] }
    if (Array.isArray(v.selected) && Array.isArray(v.unselected)) {
      return v.selected.length === 0 && v.unselected.length === 0;
    }
  }
  return false;
}

function normalizeValue(v) {
  if (Array.isArray(v)) return v.join(", ");
  if (typeof v === "object" && v && Array.isArray(v.selected)) {
    return {
      selected: v.selected,
      unselected: v.unselected,
    };
  }
  return String(v);
}

function valueOrMissing(id) {
  const v = form[id];
  if (isMissing(v)) return `Field ${id} wasn't entered.`;
  return normalizeValue(v);
}

function sanitizeLabel(s) {
  return String(s)
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-_]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

// Determine P1 from severity, then map to Jira priority name
const severity = Array.isArray(form["severity"]) ? form["severity"][0] : undefined;
const isP1 =
  typeof severity === "string" &&
  severity.startsWith("Major functionality not working");

const jiraPriorityName = isP1 ? "High" : "Medium"; // standard priorities

// Effective SDK version for labeling
const sdkVersion = Array.isArray(form["sdk-version"]) ? form["sdk-version"][0] : undefined;
const sdkVersionOther = form["sdk-version-other"];
const effectiveSdkVersion =
  sdkVersion === "Other (specify below)" ? (sdkVersionOther ?? "Other") : (sdkVersion ?? "unknown");

// Log ALL fields (required + optional) exactly as requested
const fieldLog = {};
for (const id of FIELD_IDS) {
  fieldLog[id] = valueOrMissing(id);
}

console.log("=== Parsed Issue Form Fields (by ID) ===");
console.log(JSON.stringify(fieldLog, null, 2));

// Build Jira labels (always include cmp + android)
const jiraLabels = Array.from(
  new Set([
    "cmp",
    "android",
    "source-github",
    `gh-issue-${issueNumber}`,
    `sdk-${sanitizeLabel(effectiveSdkVersion)}`,
    ...ghLabels.map(sanitizeLabel),
  ])
).slice(0, 50);

// ADF helpers (Jira v3 description requires Atlassian Document Format) :contentReference[oaicite:4]{index=4}
function adfText(text) {
  return { type: "text", text: String(text) };
}
function adfParagraph(text) {
  return { type: "paragraph", content: [adfText(text)] };
}
function adfHeading(text, level = 3) {
  return { type: "heading", attrs: { level }, content: [adfText(text)] };
}
function adfCodeBlock(code, language = "shell") {
  return {
    type: "codeBlock",
    attrs: { language },
    content: [{ type: "text", text: String(code ?? "") }],
  };
}

// Put all fields into description (including "Field X wasn't entered.")
const descriptionContent = [
  adfHeading("GitHub Issue", 2),
  adfParagraph(`#${issueNumber} by ${issueAuthor}`),
  adfParagraph(issueUrl),

  adfHeading("Form Fields", 2),
  ...FIELD_IDS
    .filter(id => id !== "logs")
    .map(id => adfParagraph(`${id}: ${typeof fieldLog[id] === "string" ? fieldLog[id] : JSON.stringify(fieldLog[id])}`)),

  adfHeading("logs", 2),
  typeof fieldLog.logs === "string" && fieldLog.logs.startsWith("Field ")
    ? adfParagraph(fieldLog.logs)
    : adfCodeBlock(
        // If logs is an object/string, normalize:
        typeof fieldLog.logs === "string" ? fieldLog.logs : JSON.stringify(fieldLog.logs, null, 2),
        "shell"
      ),
];

const jiraPayload = {
  fields: {
    project: { key: JIRA_PROJECT_KEY },
    issuetype: { name: JIRA_ISSUE_TYPE },
    summary: `[Android SDK] ${issueTitle}`.trim(),
    priority: { name: jiraPriorityName },
    labels: jiraLabels,
    description: {
      type: "doc",
      version: 1,
      content: descriptionContent,
    },
  },
  properties: [
    { key: "github.issue.url", value: issueUrl },
    { key: "github.issue.number", value: Number(issueNumber) },
    { key: "github.repo", value: repoFull },
  ],
};

// --- Call Jira (Create issue) ---
const basic = Buffer.from(`${JIRA_EMAIL}:${JIRA_API_TOKEN}`).toString("base64");

async function jiraCreateIssue(payload) {
  const res = await fetch(`${JIRA_BASE_URL}/rest/api/3/issue`, {
    method: "POST",
    headers: {
      "Authorization": `Basic ${basic}`,
      "Accept": "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Jira create issue failed (${res.status}): ${text}`);
  }
  return JSON.parse(text);
}

const created = await jiraCreateIssue(jiraPayload);
const jiraKey = created.key;
const jiraBrowseUrl = `${JIRA_BASE_URL}/browse/${jiraKey}`;

console.log(`Created Jira issue: ${jiraKey} (${jiraBrowseUrl})`);

// --- Comment back on GitHub issue ---
async function ghCreateComment(body) {
  const res = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}/comments`,
    {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${GITHUB_TOKEN}`,
        "Accept": "application/vnd.github+json",
      },
      body: JSON.stringify({ body }),
    }
  );

  const text = await res.text();
  if (!res.ok) throw new Error(`GitHub comment failed (${res.status}): ${text}`);
}

const ticketCreated =
  `✅ Created internal Jira ticket: **${jiraKey}**\n\n` +
  `${jiraBrowseUrl}\n\n` +
  `<!-- jira-key:${jiraKey} -->`;

console.log(ticketCreated);

const commentBody =
  `Thanks for the report — we’ve received it and will triage it internally.\n\n` +
  `Our SDK engineering team has been notified and will follow this issue for updates.\n\n` +
  `Please keep updates here (repro steps, logs, screenshots, or a minimal repro repo) so we can move faster.`;

await ghCreateComment(commentBody);

console.log("Commented Jira link back on GitHub issue.");
