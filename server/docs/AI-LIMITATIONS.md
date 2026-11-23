# READYLINK AI Assessment: Capabilities and Limitations

## 1. Purpose

READYLINK uses AI-assisted assessment to provide preliminary suggestions about reported community hazards. The assessment can suggest a hazard category, risk level, and explanation based on the report information.

The AI output is intended to support barangay administrators. It is not a final hazard determination, professional inspection, or replacement for human verification.

## 2. Gemini-Assisted Assessment

When Gemini is enabled and properly configured, READYLINK sends the report description, selected hazard category, and uploaded photo (when provided) to the configured Gemini model.

The model may return:
- An assessment outcome
- A suggested hazard category
- A suggested risk level
- A possible hazard name when the category is Other
- A short explanation

The backend validates the model response before accepting it. Invalid or incomplete responses are not treated as valid Gemini assessments.

Photo analysis is available only when the Gemini assessment path is active and a photo is supplied. A photo does not guarantee that the hazard will be correctly identified.

## 3. Rule-Based Fallback

When Gemini is disabled, unavailable, times out, encounters a network error, or returns an invalid response, READYLINK uses a deterministic rule-based fallback.

The fallback uses the report description and selected hazard category. It does not analyze the uploaded photo.

For recognized categories, the fallback uses fixed default risk levels:

| Hazard category | Default risk level |
|---|---|
| Tree | Moderate |
| Drain | Moderate |
| Road | Moderate |
| Pole | High |
| Flood | High |
| Slope | High |
| River | High |
| Wall | Moderate |
| Other | Moderate |

These are category defaults, not measurements of actual hazard severity. For example, two road reports describing hazards of very different severity may receive the same default risk level.

If the fallback cannot classify the description or identify a supported category, it returns an `uncertain` outcome instead of claiming that no hazard exists.

## 4. Assessment Outcomes

The AI assessment service supports four outcomes:

| Outcome | Meaning |
|---|---|
| `hazard_detected` | A possible hazard was identified and may include a suggested category and risk level. |
| `no_hazard_detected` | The model did not identify a hazard in the submitted information. |
| `uncertain` | The available information is insufficient for a confident assessment. |
| `unsupported` | The submitted information does not fit the supported assessment categories or task. |

The report-submission workflow does not accept `no_hazard_detected`, `uncertain`, or `unsupported` as confirmed hazard reports. These outcomes must not be interpreted as proof that an area is safe.

## 5. Error Handling

READYLINK handles several possible Gemini failures:

- HTTP errors from the Gemini service
- Network failures
- Request timeouts
- Invalid JSON responses
- Empty or malformed model responses
- Responses that fail the expected assessment schema

When these failures occur, the service attempts to provide a rule-based fallback assessment instead of allowing the AI request to crash the application.

The backend also validates assessment fields, including allowed categories, risk levels, outcome values, and explanation length.

## 6. Important Limitations

The AI assessment has the following limitations:

1. AI suggestions may be incorrect or incomplete.
2. Photo interpretation may fail to recognize a hazard or may misinterpret an image.
3. Image quality, lighting, camera angle, and incomplete report descriptions can affect assessment results.
4. The rule-based fallback does not analyze photos.
5. Fallback risk levels are fixed defaults by category and do not measure actual hazard severity.
6. An uncertain or no-hazard result does not establish that a location is safe.
7. AI-generated explanations are preliminary and should not be treated as verified field observations.
8. The system does not replace an on-site inspection or the judgment of qualified personnel.

## 7. Human Verification

Barangay administrators are responsible for reviewing submitted reports and verifying relevant information before taking administrative action.

AI-generated categories, risk levels, and explanations should be treated as decision-support information only. Administrators should consider the report details, location, available evidence, and actual conditions before changing a report's status or prioritization.

## 8. Prototype Status

READYLINK is a prototype intended for project demonstration and evaluation.

The current application includes demo-related functionality and sample data. Its offline simulation is not equivalent to a fully implemented offline reporting and synchronization system.

AI availability depends on the server configuration and a valid Gemini API configuration. The application should not be presented as a fully autonomous or production-ready disaster assessment system.

## 9. Testing Evidence

The AI integration tests cover:
- Valid Gemini assessment responses
- Uploaded photo handling
- Assessment schema and explanation validation
- Invalid request handling
- Same-origin protection and rate limiting
- Gemini HTTP failures
- Request timeouts
- Invalid Gemini responses
- Rule-based fallback behavior
- Unclassified descriptions returning `uncertain`
- Gemini network failures and fallback behavior

Passing automated tests demonstrates that the tested application behaviors work as expected under the tested conditions. It does not prove the real-world accuracy of AI hazard detection.
