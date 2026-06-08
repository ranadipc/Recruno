import fs from "node:fs/promises";
import path from "node:path";
import { SpreadsheetFile, Workbook } from "@oai/artifact-tool";

const inputPath = "C:/Users/ranad/Downloads/dataset_linkedin-profile-scraper_2026-06-07_11-47-12-939.json";
const outputDir = "C:/Users/ranad/Downloads/Recruno Auto/outputs/apify-dataset-2026-06-07";
const outputPath = path.join(outputDir, "Apify_LinkedIn_Profiles_2026-06-07.xlsx");

const data = JSON.parse(await fs.readFile(inputPath, "utf8"));
const profiles = Array.isArray(data) ? data : [data];

const text = (value) => typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
const obj = (value) => value && typeof value === "object" && !Array.isArray(value) ? value : {};
const list = (value) => Array.isArray(value) ? value : [];
const fullName = (profile) => [text(profile.firstName), text(profile.lastName)].filter(Boolean).join(" ") || text(profile.fullName) || text(profile.name);
const linkedinUrl = (profile) => text(profile.linkedinUrl) || text(obj(profile.originalQuery).query);
const locationText = (value) => {
  const location = obj(value);
  const parsed = obj(location.parsed);
  return text(location.linkedinText) || text(parsed.text) || [text(parsed.city), text(parsed.state), text(parsed.countryFull || parsed.country)].filter(Boolean).join(", ");
};
const dateText = (value) => text(obj(value).text) || [text(obj(value).month), text(obj(value).year)].filter(Boolean).join(" ");
const currentRole = (profile) => {
  const current = list(profile.currentPosition)[0];
  if (current) return current;
  return list(profile.experience).find((role) => /present/i.test(dateText(role.endDate))) || list(profile.experience)[0] || {};
};
const names = (items, keys) => list(items).map((item) => {
  if (typeof item === "string") return item;
  for (const key of keys) {
    const value = text(item?.[key]);
    if (value) return value;
  }
  return "";
}).filter(Boolean);

const candidateHeaders = [
  "Candidate Name", "LinkedIn URL", "Headline", "Location", "City", "State", "Country",
  "Current Title", "Current Company", "Current Role Start", "Open to Work", "Hiring",
  "Connections", "Followers", "Emails", "Top Skills", "About", "Experience Count",
  "Education Count", "Skills Count", "Languages", "Original Query", "Raw JSON"
];

const candidateRows = profiles.map((profile) => {
  const role = currentRole(profile);
  const parsedLocation = obj(obj(profile.location).parsed);
  return [
    fullName(profile),
    linkedinUrl(profile),
    text(profile.headline),
    locationText(profile.location),
    text(parsedLocation.city),
    text(parsedLocation.state),
    text(parsedLocation.countryFull || parsedLocation.country),
    text(role.position || role.title),
    text(role.companyName || role.company),
    dateText(role.startDate),
    Boolean(profile.openToWork),
    Boolean(profile.hiring),
    Number(profile.connectionsCount || 0),
    Number(profile.followerCount || 0),
    names(profile.emails, ["email", "value"]).join("; "),
    names(profile.topSkills, ["name", "text"]).join("; "),
    text(profile.about),
    list(profile.experience).length,
    list(profile.education).length,
    list(profile.skills).length,
    names(profile.languages, ["name", "language"]).join("; "),
    text(obj(profile.originalQuery).query),
    JSON.stringify(profile)
  ];
});

const experienceHeaders = [
  "Candidate Name", "LinkedIn URL", "Position", "Company", "Location", "Employment Type",
  "Workplace Type", "Start Date", "End Date", "Period", "Current Role", "Description"
];
const experienceRows = profiles.flatMap((profile) => list(profile.experience).map((role) => [
  fullName(profile),
  linkedinUrl(profile),
  text(role.position || role.title),
  text(role.companyName || role.company),
  text(role.location),
  text(role.employmentType),
  text(role.workplaceType),
  dateText(role.startDate),
  dateText(role.endDate),
  text(role.period || role.duration),
  /present/i.test(dateText(role.endDate)),
  text(role.description)
]));

const educationHeaders = [
  "Candidate Name", "LinkedIn URL", "School", "Degree", "Field of Study",
  "Start Date", "End Date", "Period", "Description"
];
const educationRows = profiles.flatMap((profile) => list(profile.education).map((education) => [
  fullName(profile),
  linkedinUrl(profile),
  text(education.schoolName || education.school || education.name),
  text(education.degree),
  text(education.fieldOfStudy),
  dateText(education.startDate),
  dateText(education.endDate),
  text(education.period),
  text(education.description || education.insights)
]));

const skillHeaders = ["Candidate Name", "LinkedIn URL", "Skill"];
const skillRows = profiles.flatMap((profile) => names(profile.skills, ["name", "text", "skillName"]).map((skill) => [
  fullName(profile), linkedinUrl(profile), skill
]));

const languageHeaders = ["Candidate Name", "LinkedIn URL", "Language", "Proficiency"];
const languageRows = profiles.flatMap((profile) => list(profile.languages).map((language) => [
  fullName(profile),
  linkedinUrl(profile),
  text(language.name || language.language),
  text(language.proficiency)
]));

const workbook = Workbook.create();
const summary = workbook.worksheets.add("Summary");
const candidates = workbook.worksheets.add("Candidates");
const experience = workbook.worksheets.add("Experience");
const education = workbook.worksheets.add("Education");
const skills = workbook.worksheets.add("Skills");
const languages = workbook.worksheets.add("Languages");

const headerFormat = {
  fill: "#0B806B",
  font: { bold: true, color: "#FFFFFF" },
  wrapText: true,
  verticalAlignment: "center",
  borders: { preset: "all", style: "thin", color: "#D0D5DD" }
};
const titleFormat = {
  fill: "#132420",
  font: { bold: true, color: "#FFFFFF", size: 18 },
  verticalAlignment: "center"
};
const subtitleFormat = { font: { color: "#475467", italic: true }, wrapText: true };

function buildDataSheet(sheet, headers, rows, tableName, widths, rowHeight = 28) {
  sheet.showGridLines = false;
  sheet.getRangeByIndexes(0, 0, 1, headers.length).values = [headers];
  if (rows.length) sheet.getRangeByIndexes(1, 0, rows.length, headers.length).values = rows;
  sheet.getRangeByIndexes(0, 0, 1, headers.length).format = headerFormat;
  sheet.getRangeByIndexes(0, 0, rows.length + 1, headers.length).format.borders = { preset: "all", style: "thin", color: "#E4E7EC" };
  sheet.getRangeByIndexes(1, 0, Math.max(rows.length, 1), headers.length).format.verticalAlignment = "top";
  sheet.getRangeByIndexes(1, 0, Math.max(rows.length, 1), headers.length).format.wrapText = true;
  sheet.getRangeByIndexes(1, 0, Math.max(rows.length, 1), headers.length).format.rowHeight = rowHeight;
  widths.forEach((width, index) => {
    sheet.getRangeByIndexes(0, index, Math.max(rows.length + 1, 1), 1).format.columnWidth = width;
  });
  sheet.getRange("A:A").format.font = { bold: true };
  sheet.freezePanes.freezeRows(1);
  sheet.freezePanes.freezeColumns(2);
  if (rows.length) {
    const endColumn = columnName(headers.length);
    const table = sheet.tables.add(`A1:${endColumn}${rows.length + 1}`, true, tableName);
    table.style = "TableStyleMedium4";
    table.showBandedRows = true;
  }
}

function columnName(count) {
  let value = count;
  let result = "";
  while (value > 0) {
    value -= 1;
    result = String.fromCharCode(65 + (value % 26)) + result;
    value = Math.floor(value / 26);
  }
  return result;
}

buildDataSheet(candidates, candidateHeaders, candidateRows, "CandidatesTable",
  [22, 34, 42, 28, 16, 18, 16, 26, 24, 16, 13, 10, 13, 12, 28, 35, 58, 14, 14, 12, 30, 38, 35], 50);
buildDataSheet(experience, experienceHeaders, experienceRows, "ExperienceTable",
  [22, 34, 28, 24, 22, 16, 16, 14, 14, 18, 12, 65], 55);
buildDataSheet(education, educationHeaders, educationRows, "EducationTable",
  [22, 34, 34, 28, 24, 14, 14, 18, 55], 42);
buildDataSheet(skills, skillHeaders, skillRows, "SkillsTable", [22, 34, 32], 22);
buildDataSheet(languages, languageHeaders, languageRows, "LanguagesTable", [22, 34, 24, 28], 22);
candidates.getRange(`W2:W${candidateRows.length + 1}`).format.wrapText = false;

candidates.getRange(`K2:L${candidateRows.length + 1}`).conditionalFormats.add("cellIs", {
  operator: "equal",
  formula: "TRUE",
  format: { fill: "#E9F8EF", font: { color: "#05603A", bold: true } }
});
experience.getRange(`K2:K${experienceRows.length + 1}`).conditionalFormats.add("cellIs", {
  operator: "equal",
  formula: "TRUE",
  format: { fill: "#EEF4FF", font: { color: "#1849A9", bold: true } }
});

summary.showGridLines = false;
summary.mergeCells("A1:H2");
summary.getRange("A1:H2").values = [["Apify LinkedIn Profile Dataset"]];
summary.getRange("A1:H2").format = titleFormat;
summary.mergeCells("A3:H3");
summary.getRange("A3:H3").values = [[`Source: ${path.basename(inputPath)} | Generated from ${profiles.length} Apify records`]];
summary.getRange("A3:H3").format = subtitleFormat;

summary.getRange("A5:B5").values = [["Metric", "Value"]];
summary.getRange("A5:B5").format = headerFormat;
summary.getRange("A6:A12").values = [
  ["Total profiles"], ["Open to Work"], ["Hiring"], ["Profiles with email"],
  ["Experience rows"], ["Education rows"], ["Skill rows"]
];
summary.getRange("B6:B12").formulas = [
  [`=COUNTA(Candidates!A2:A${candidateRows.length + 1})`],
  [`=COUNTIF(Candidates!K2:K${candidateRows.length + 1},TRUE)`],
  [`=COUNTIF(Candidates!L2:L${candidateRows.length + 1},TRUE)`],
  [`=COUNTIF(Candidates!O2:O${candidateRows.length + 1},"<>")`],
  [`=COUNTA(Experience!A2:A${experienceRows.length + 1})`],
  [`=COUNTA(Education!A2:A${educationRows.length + 1})`],
  [`=COUNTA(Skills!A2:A${skillRows.length + 1})`]
];
summary.getRange("A5:B12").format.borders = { preset: "all", style: "thin", color: "#D0D5DD" };
summary.getRange("A6:A12").format.font = { bold: true, color: "#344054" };
summary.getRange("B6:B12").format.font = { bold: true, color: "#0B806B", size: 14 };

const countryCounts = new Map();
for (const profile of profiles) {
  const location = obj(obj(profile.location).parsed);
  const country = text(location.countryFull || location.country) || "Unknown";
  countryCounts.set(country, (countryCounts.get(country) || 0) + 1);
}
const topCountries = [...countryCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
summary.getRange("D5:E5").values = [["Country", "Profiles"]];
summary.getRange("D5:E5").format = headerFormat;
summary.getRangeByIndexes(5, 3, topCountries.length, 2).values = topCountries;
summary.getRange(`D5:E${topCountries.length + 5}`).format.borders = { preset: "all", style: "thin", color: "#D0D5DD" };

if (topCountries.length) {
  const chart = summary.charts.add("bar", summary.getRange(`D5:E${topCountries.length + 5}`));
  chart.title = "Profiles by Country";
  chart.hasLegend = false;
  chart.setPosition("G5", "N18");
}

summary.getRange("A14:H14").merge();
summary.getRange("A14:H14").values = [["Workbook Guide"]];
summary.getRange("A14:H14").format = headerFormat;
const guideRows = [
  "Candidates: one row per LinkedIn profile with current role, location, counts, and raw JSON.",
  "Experience: one row per employment entry.",
  "Education: one row per education entry.",
  "Skills and Languages: normalized rows for filtering or pivoting.",
  "Use the filters in each table; the first two columns are frozen for easier review."
];
guideRows.forEach((value, index) => {
  const row = 15 + index;
  summary.mergeCells(`A${row}:H${row}`);
  summary.getRange(`A${row}:H${row}`).values = [[value]];
});
summary.getRange("A15:H19").format = { wrapText: true, verticalAlignment: "top", borders: { preset: "all", style: "thin", color: "#E4E7EC" } };
summary.getRange("A:H").format.columnWidth = 18;
summary.getRange("A:A").format.columnWidth = 25;
summary.getRange("D:D").format.columnWidth = 20;
summary.freezePanes.freezeRows(3);

await fs.mkdir(outputDir, { recursive: true });
const previewSheets = [
  ["Summary", "A1:N19"],
  ["Candidates", "A1:V12"],
  ["Experience", "A1:L12"],
  ["Education", "A1:I12"],
  ["Skills", "A1:C16"],
  ["Languages", "A1:D16"]
];
for (const [sheetName, range] of previewSheets) {
  const preview = await workbook.render({ sheetName, range, scale: 0.8, format: "png" });
  await fs.writeFile(path.join(outputDir, `${sheetName.toLowerCase()}-preview.png`), new Uint8Array(await preview.arrayBuffer()));
}

const inspect = await workbook.inspect({
  kind: "table",
  range: "Candidates!A1:W8",
  include: "values,formulas",
  tableMaxRows: 8,
  tableMaxCols: 23,
  maxChars: 5000
});
await fs.writeFile(path.join(outputDir, "inspection.ndjson"), inspect.ndjson, "utf8");

const errors = await workbook.inspect({
  kind: "match",
  searchTerm: "#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A",
  options: { useRegex: true, maxResults: 100 },
  summary: "formula error scan"
});
await fs.writeFile(path.join(outputDir, "errors.ndjson"), errors.ndjson, "utf8");

const output = await SpreadsheetFile.exportXlsx(workbook);
await output.save(outputPath);
console.log(JSON.stringify({
  outputPath,
  profiles: profiles.length,
  experienceRows: experienceRows.length,
  educationRows: educationRows.length,
  skillRows: skillRows.length,
  languageRows: languageRows.length
}, null, 2));
