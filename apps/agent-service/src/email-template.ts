import type { DraftProfileFields } from "./gemini";

// HTML for the onboarding draft-profile email. Email-client-safe: table layout,
// inline styles, web-safe fonts (Lato where supported, Helvetica/Arial otherwise),
// no flex/grid/JS. All dynamic values are HTML-escaped. A plain-text fallback is
// built separately in onboarding.ts (formatProfileForEmail) and sent alongside.

function esc(s: string | null | undefined): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function pill(label: string): string {
  return `<span style="display:inline-block; background:#eef2ff; color:#4338ca; border:1px solid #dcdcfb; border-radius:6px; padding:5px 11px; font-size:12.5px; line-height:1; margin:0 6px 8px 0;">${esc(label)}</span>`;
}

export function draftProfileHtml(profile: DraftProfileFields): string {
  const company = esc(profile.companyName) || "Your company";
  const industry = profile.industry ? esc(profile.industry) : "";
  const size = profile.size ? esc(profile.size) : "";
  const summary = profile.summary
    ? esc(profile.summary)
    : "We couldn't find much public information about your company yet — reply and fill in the gaps, and we'll take it from there.";
  const sectors = (profile.sectors ?? []).filter(Boolean);
  const keywords = (profile.keywords ?? []).filter(Boolean);

  // Right-hand facts column: render only what we actually have.
  const facts =
    (industry
      ? `<div style="font-size:11px; text-transform:uppercase; letter-spacing:.05em; color:#90a1b9; font-weight:700;">Industry</div>` +
        `<div style="font-size:15px; font-weight:700; color:#0b1220; margin-top:3px;">${industry}</div>`
      : "") +
    (size
      ? `<div style="font-size:11px; text-transform:uppercase; letter-spacing:.05em; color:#90a1b9; font-weight:700; margin-top:${industry ? "13px" : "0"};">Size</div>` +
        `<div style="font-size:15px; font-weight:700; color:#0b1220; margin-top:3px;">${size}</div>`
      : "");

  // Company block: full width if we have no industry/size, else a 2-col split.
  const factsRow = facts
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
         <td width="50%" style="vertical-align:top; padding-right:20px;">
           <div style="font-size:11px; text-transform:uppercase; letter-spacing:.05em; color:#90a1b9; font-weight:700;">Company</div>
           <div style="font-size:20px; font-weight:900; color:#0b1220; line-height:1.25; margin-top:3px;">${company}</div>
         </td>
         <td width="50%" style="vertical-align:top; padding-left:22px; border-left:2px solid #eef2ff;">${facts}</td>
       </tr></table>`
    : `<div style="font-size:11px; text-transform:uppercase; letter-spacing:.05em; color:#90a1b9; font-weight:700;">Company</div>
       <div style="font-size:20px; font-weight:900; color:#0b1220; line-height:1.25; margin-top:3px;">${company}</div>`;

  const sectorsHtml = sectors.length
    ? sectors.map(pill).join("")
    : `<span style="font-size:13px; color:#90a1b9;">—</span>`;
  const keywordsHtml = keywords.length ? esc(keywords.join(", ")) : "—";

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="x-apple-disable-message-reformatting"><title>Your company profile</title>
<style>@import url('https://fonts.googleapis.com/css2?family=Lato:wght@400;700;900&display=swap');</style>
</head>
<body style="margin:0; padding:0; background:#eceef3; -webkit-text-size-adjust:100%; font-family:'Lato','Helvetica Neue',Helvetica,Arial,sans-serif;">
<div style="display:none; max-height:0; overflow:hidden; opacity:0; color:#eceef3; font-size:1px;">Here's the company profile we put together — confirm it, or reply with changes.</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#eceef3;">
<tr><td align="center" style="padding:26px 12px;">
<table role="presentation" width="760" cellpadding="0" cellspacing="0" border="0" style="width:760px; max-width:760px; background:#ffffff; border-radius:16px; overflow:hidden; border:1px solid #dfe3ec; font-family:'Lato','Helvetica Neue',Helvetica,Arial,sans-serif;">

<tr><td style="padding:16px 36px; border-bottom:1px solid #eef0f5;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
<td style="vertical-align:middle;">
<span style="display:inline-block; width:24px; height:24px; background:#4f46e5; background-image:linear-gradient(135deg,#4f46e5,#7c5cf0); border-radius:7px; color:#fff; font-size:15px; text-align:center; line-height:24px; vertical-align:middle;">&#9678;</span>
<span style="font-size:15px; font-weight:700; color:#0b1220; vertical-align:middle; padding-left:8px;">Radar</span>
<span style="font-size:12px; color:#90a1b9; vertical-align:middle;">&nbsp;by AHI</span>
</td>
<td align="right" style="vertical-align:middle;">
<span style="display:inline-block; background:#ecfdf5; color:#047857; font-size:11px; font-weight:700; letter-spacing:.03em; text-transform:uppercase; padding:4px 10px; border-radius:999px;">Profile ready</span>
</td>
</tr></table>
</td></tr>

<tr><td style="padding:26px 36px 4px;">
<span style="font-size:11px; letter-spacing:.09em; text-transform:uppercase; color:#4338ca; font-weight:700;">Your profile</span>
<p style="margin:12px 0 20px; font-size:13.5px; color:#8a94a3;">Here's what we found about your company. Have a quick look.</p>
${factsRow}
</td></tr>

<tr><td style="padding:20px 36px 4px;">
<p style="margin:0; font-size:14.5px; line-height:1.62; color:#3a4553;">${summary}</p>
</td></tr>

<tr><td style="padding:20px 36px 8px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
<td width="60%" style="vertical-align:top; padding-right:22px;">
<div style="margin:0 0 11px; font-size:11px; letter-spacing:.06em; text-transform:uppercase; color:#90a1b9; font-weight:700;">Sectors we'll track</div>
${sectorsHtml}
</td>
<td width="40%" style="vertical-align:top; padding-left:22px; border-left:1px solid #eef0f5;">
<div style="margin:0 0 9px; font-size:11px; letter-spacing:.06em; text-transform:uppercase; color:#90a1b9; font-weight:700;">Keywords</div>
<p style="margin:0; font-size:12.5px; line-height:1.7; color:#64748b;">${keywordsHtml}</p>
</td>
</tr></table>
</td></tr>

<tr><td style="padding:16px 36px 30px;">
<div style="background:#f7f8fc; border:1px solid #e6e9f0; border-radius:14px; padding:22px 22px;">
<span style="font-size:11px; letter-spacing:.09em; text-transform:uppercase; color:#4338ca; font-weight:700;">What's next</span>
<p style="margin:12px 0 16px; font-size:14px; color:#64748b;">Just reply to this email — two ways to go:</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
<td width="49%" valign="top" style="background:#4f46e5; border-radius:12px; padding:17px 19px;">
<div style="font-size:15px; font-weight:900; color:#ffffff;">Looks right — go ahead</div>
<p style="margin:8px 0 0; font-size:13px; line-height:1.55; color:#e3e0ff;">Reply <b style="color:#ffffff;">&ldquo;yes&rdquo;</b> and we'll start finding public tenders that match this profile.</p>
</td>
<td width="2%" style="font-size:0; line-height:0;">&nbsp;</td>
<td width="49%" valign="top" style="background:#ffffff; border:1px solid #dfe3ec; border-radius:12px; padding:17px 19px;">
<div style="font-size:15px; font-weight:900; color:#0b1220;">Something to change?</div>
<p style="margin:8px 0 0; font-size:13px; line-height:1.55; color:#64748b;">Reply with what to fix — a wrong sector, your size, anything — and we'll update it first.</p>
</td>
</tr></table>
</div>
</td></tr>

<tr><td style="padding:0 36px 26px;"><p style="margin:0; font-size:12px; line-height:1.6; color:#a5adba;">Radar by AHI &nbsp;&middot;&nbsp; You asked us for a tender report. Don't want it? Just reply.</p></td></tr>

</table>
</td></tr>
</table>
</body></html>`;
}
