# Kalvora Technologies HR Policy Corpus (synthetic)

500 Word documents: 50 HR policies, each in a separate version for each of 10 countries. They were built as a test dataset for retrieval-augmented generation (RAG) and other GenAI systems.

> **Kalvora Technologies is a fictional company.** All names, entities, email addresses (`*.kalvora.example`), entitlements and figures set by the company are invented. Statutory references aim to reflect each country's position as at November 2026 but have not been legally reviewed. **Do not use these documents as real policy or as legal advice.**

## Structure

```
Kalvora_HR_Policies/
├── index.csv          one row per document, all metadata (opens in Excel)
├── manifest.jsonl     the same metadata as JSON Lines, for loading into a pipeline
├── Australia/         50 .docx files
├── Canada/            (Ontario law)
├── Germany/
├── India/
├── Netherlands/
├── Philippines/
├── Singapore/
├── United Arab Emirates/
├── United Kingdom/
└── United States/     (federal law plus Texas and New Jersey)
```

**Document ID:** `KAL-{country code}-HR-{policy number}`, for example `KAL-GB-HR-016`, the UK Maternity Leave Policy. Each policy number is the same in every country, so `HR-016` is always Maternity Leave.

**Country codes:** IN, US, GB, DE, NL, SG, AU, CA, AE, PH.

## What each document contains (1,140–1,440 words)

- A metadata table: ID, version, country, legal entity, category, effective date, review dates, owner and approver. The same metadata is also stored in the .docx file properties (title, subject, keywords).
- 14 numbered sections. Sections 1–5 and 7–14 follow a global template. **Section 6, "Country-Specific Provisions", holds the local law, statutory entitlements and Kalvora's enhancements**, so it is where the versions of one policy differ most.
- Cross-references to related policies by document ID (Section 12).
- A revision history table. Some recent entries record real legal changes, such as India's Labour Codes (November 2025), the UK Employment Rights Act 2025, and Singapore's and Australia's 2026 parental leave changes.

## Why it is useful for RAG testing

- **Near-duplicates across countries.** All 10 versions of a policy share most of their wording. A good retriever must use country signals to return the right one, for example the UK version for "How many weeks of paid partner leave do UK employees get?".
- **Facts that differ by country.** Notice periods, leave days, overtime rates, thresholds and the names of local laws vary, which makes them good for testing whether answers are grounded in the right document.
- **Multi-hop questions.** Some answers need two documents, using the related-policy IDs (for example, the Disciplinary Policy together with the Code of Conduct).
- **Global commitments.** A few company standards are the same everywhere (four weeks of paid partner leave, at least 10 days of domestic violence leave, two volunteering days), so you can test questions that should be answerable from any country's version.

## Categories (policy numbers)

| Category | Policies |
|---|---|
| Talent Acquisition & Onboarding | 001–005 |
| Employment & Working Time | 006–012 |
| Leave & Time Off | 013–023 |
| Compensation & Benefits | 024–030 |
| Conduct & Ethics | 031–039 |
| Data & Technology | 040–042 |
| Health, Safety & Wellbeing | 043–044 |
| Performance & Employee Relations | 045–048 |
| Separation | 049–050 |
