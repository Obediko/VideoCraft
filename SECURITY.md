# Security policy

VideoCraft will handle user media, transcripts, audience information, and generated outputs. Treat uploaded media and model output as untrusted.

Before production use, require authenticated project authorization, tenant isolation, signed short-lived media URLs, upload limits and checksum validation, malware scanning, sandboxed media processing, validated model output, server-side secrets, audit events, retention and deletion workflows, rate limits, and log redaction.

AI output is advisory. Persist provenance, confidence, strategy version, and evidence. Low-confidence or policy-sensitive suggestions must remain reviewable and must not silently change a project.

Feedback is used for evaluation and product improvement. It is not automatic model training, and no training pipeline should consume feedback without explicit data-governance review.

Do not commit credentials, source media, personal data, or sensitive provider responses. Report vulnerabilities privately to the repository owner.
