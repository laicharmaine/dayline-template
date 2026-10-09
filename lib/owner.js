'use strict';
// Who this Dayline belongs to. Set OWNER_NAME (and optionally OWNER_ABOUT) in your env;
// used only to sign thank-you drafts and to brief the optional Gemini helper.
const ownerName = () => String(process.env.OWNER_NAME || '').trim();
const ownerAbout = () => String(process.env.OWNER_ABOUT || '').trim() || 'a student recruiting for internships';
const signName = () => ownerName() || '[Your name]';
const signOff = () => `\n\nBest,\n${signName()}`;
const sender = () => `${ownerName() || 'The sender'} (${ownerAbout()})`;
module.exports = { ownerName, ownerAbout, signName, signOff, sender };
