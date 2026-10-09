'use strict';
// FAKE sample people for fixture mode and tests only. Every name, email and link here is made up
// (example.com addresses, "Sample"/"Example"-style surnames). Live mode never uses this file.
const { addDays } = require('./time');

const P = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const T = (n) => `00000000-0000-4000-9000-${String(n).padStart(12, '0')}`;
// Fixture Pipeline job ids (data/fixtures/notion-jobs.json)
const JOB = { contoso: 'bbbbbbbb-0000-4000-8000-0000000000c1', fabrikam: 'bbbbbbbb-0000-4000-8000-0000000000f1', northwind: 'bbbbbbbb-0000-4000-8000-0000000000a1' };

function sampleNetwork(today) {
  const d = (n) => addDays(today, n);
  const person = (n, f) => ({
    id: P(n), company: '', role: '', school: '', howMet: '', linkedin: null, email: null, strength: null, tags: [], nextFollowUp: null, notes: '',
    introducedBy: [], jobIds: [], addedBy: 'Me', url: null, created: `${d(-30)}T15:00:00.000Z`, edited: `${d(-2)}T15:00:00.000Z`, ...f,
  });
  const touch = (n, f) => ({ id: T(n), notes: '', action: '', followUp: null, jobId: null, addedBy: 'Me', url: null, created: `${f.date}T18:00:00.000Z`, ...f });
  const people = [
    person(1, { name: 'Avery Sample', company: 'Contoso', role: 'Senior PMM, Cloud', school: 'Alum (sample)', howMet: 'Alumni directory', linkedin: 'https://example.com/in/avery-sample', email: 'avery@example.com', strength: 'Strong', tags: ['PMM', 'Alum'], nextFollowUp: d(-2), notes: 'Sample contact. Offered to refer me for the Marketing MBA internship.', jobIds: [JOB.contoso] }),
    person(2, { name: 'Jordan Example', company: 'Contoso', role: 'PM Manager, Assistant', howMet: 'Intro from Avery', email: 'jordan@example.com', strength: 'Warm', tags: ['PM', 'Hiring manager'], introducedBy: [P(1)], nextFollowUp: d(0) }),
    person(3, { name: 'Riley Placeholder', company: 'Fabrikam', role: 'Product Manager, Data Platform', school: 'Alum (sample)', howMet: 'Tech trek', linkedin: 'https://example.com/in/riley-placeholder', strength: 'Warm', tags: ['PM', 'Alum'], nextFollowUp: d(4) }),
    person(4, { name: 'Sam Fixture', company: 'Litware', role: 'Recruiter, University', howMet: 'Info session', email: 'sam@example.com', strength: 'Cold', tags: ['Recruiter'] }),
    person(5, { name: 'Casey Demo', company: 'Northwind', role: 'Product Marketing Lead', howMet: 'Intro from Riley', strength: 'Warm', tags: ['PMM'], introducedBy: [P(3)], nextFollowUp: d(10) }),
    person(6, { name: 'Morgan Testwell', company: 'Tailspin Toys', role: 'APM Program Lead', howMet: 'LinkedIn cold message', linkedin: 'https://example.com/in/morgan-testwell', strength: 'Cold', tags: ['PM'] }),
    person(7, { name: 'Taylor Mock', company: 'Litware', role: 'Product Manager', howMet: 'Intro from Sam', strength: 'Cold', tags: ['PM'], introducedBy: [P(4)], nextFollowUp: d(-5) }),
    person(8, { name: 'Quinn Sampleton', company: 'Sample University', role: 'Career coach (sample)', howMet: 'Career management center', strength: 'Strong', tags: ['Referral'] }),
  ];
  const touches = [
    touch(1, { personId: P(1), date: d(-21), type: 'Coffee chat', notes: 'How cloud PMMs partner with sales on launches. Advice: lead with one crisp customer story in interviews.', action: 'Send resume for referral', followUp: d(-14), jobId: JOB.contoso }),
    touch(2, { personId: P(1), date: d(-12), type: 'Referral ask', notes: 'Avery submitted the referral for the Marketing MBA internship.', jobId: JOB.contoso }),
    touch(3, { personId: P(2), date: d(-6), type: 'Call', notes: 'Assistant roadmap and what first-round interviewers look for: structured product sense and customer empathy.', action: 'Thank-you note + share case notes', followUp: d(0), jobId: JOB.contoso }),
    touch(4, { personId: P(3), date: d(-9), type: 'Coffee chat', notes: 'Data platform PM role scope; ramp-up on the analytics stack.', action: 'Ask about MBA intern team matching', followUp: d(4), jobId: JOB.fabrikam }),
    touch(5, { personId: P(4), date: d(-15), type: 'Info session/event', notes: 'APM intern timeline: apps close early Nov.' }),
    touch(6, { personId: P(5), date: d(-3), type: 'Coffee chat', notes: 'PMM at Northwind is very launch-driven; keep stories about cross-functional launches ready.', jobId: JOB.northwind }),
    touch(7, { personId: P(6), date: d(-1), type: 'LinkedIn message', notes: 'Sent intro note, waiting on reply.', followUp: d(6) }),
    touch(8, { personId: P(8), date: d(-25), type: 'Coffee chat', notes: 'Networking plan: 2-3 coffee chats per target company before apps.' }),
    touch(9, { personId: P(8), date: d(-4), type: 'Call', notes: 'Mock first-round interview practice.' }),
  ];
  return { people, touches };
}

module.exports = { sampleNetwork, SAMPLE_JOB_IDS: JOB, samplePersonId: P, sampleTouchId: T };
