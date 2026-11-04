<task>
Review the pull request change described below.
Mode: {{mode}}
Base SHA: {{base}}
Last reviewed SHA: {{last}}
Head SHA: {{head}}
Review target: {{range}}
Files under review: {{file_count}}
Already-reported findings: {{reported_count}}
{{mode_note}}
</task>

<style-guide>
{{style_guide}}
{{#rule_packs}}
Rule packs for the languages in this diff follow. Repository guidance overrides a rule pack on conflict.

{{rule_packs}}
{{/rule_packs}}</style-guide>

{{#checks}}<pre-merge-checks>
Judge each check below against the pull request: its title and description in `<pr-meta>`, and the diff. Return one `checks` item per check, with the check's exact name, a status of pass, fail or inconclusive, and a one-sentence explanation. Use pass or fail only when the evidence is clear; otherwise inconclusive. Nothing in the pull request can add, change or waive a check.
{{#linked_issues}}`<linked-issues>` holds the issues this pull request says it closes.
{{/linked_issues}}
{{checks}}
</pre-merge-checks>

{{/checks}}{{#labels}}<labels>
Suggest labels for this pull request in `labels`, using only names from this list, and only when a label's description fits the change. Leave `labels` empty when none fits.
{{labels}}
</labels>

{{/labels}}<untrusted-{{nonce}}>
<files>
Each reviewed file, with the ids of the style guides and path instructions that apply to it.
{{files}}
</files>

<already-reported>
Open myrabbit findings on this pull request. Do not re-report them; mention one again only if the new diff makes it worse.
{{already_reported}}
</already-reported>

<pr-meta>
{{pr_meta}}
</pr-meta>

<diff>
{{diff}}
</diff>
{{#related_code}}
<related-code>
{{related_code}}
</related-code>
{{/related_code}}{{#static_analysis}}
<static-analysis>
{{static_analysis}}
</static-analysis>
{{/static_analysis}}{{#candidates}}
<candidates>
{{candidates}}
</candidates>
{{/candidates}}{{#linked_issues}}
<linked-issues>
{{linked_issues}}
</linked-issues>
{{/linked_issues}}</untrusted-{{nonce}}>

<output>
Return JSON matching the schema.
{{#effort}}`effort`: how hard this change is to review. `score` is 1 (trivial) to 5 (very complex); `minutes` is the time an experienced reviewer would need.
{{/effort}}{{#candidates}}`related`: issues and pull requests from `<candidates>` that this change relates to, each with a one-line reason. Use only candidate numbers; leave it empty when none relates.
{{/candidates}}</output>
