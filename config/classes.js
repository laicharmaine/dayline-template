'use strict';
// Classes & activities: the one place to edit how Dayline groups tasks and calendar events.
// These are EXAMPLES. Replace them with your own (or leave the lists empty: [] to hide the Classes tab's groups).
//
//   option   = the exact option name in the Notion To Do "Class / Activity" multi-select
//              (First-time setup creates the options listed here; you can add more in Notion later)
//   name     = how Dayline shows it
//   codes    = course codes found in task / event titles (any separator works: "ABC-101", "ABC 101")
//   keywords = whole words/phrases in a task or event title (case-insensitive) for activities
//   midterm  = optional YYYY-MM-DD exam date; final = optional YYYY-MM-DD
//   color    = Notion color: default, gray, brown, orange, yellow, green, blue, purple, pink, red
//
// Matching is deliberately strict: a course code or an activity keyword must appear in the title.
module.exports = {
  classes: [
    { option: 'Class A', name: 'Class A (example: Strategy)', codes: ['ABC 101'], color: 'blue' },
    { option: 'Class B', name: 'Class B (example: Statistics)', codes: ['XYZ 202'], color: 'purple' },
  ],
  activities: [
    { option: 'Club B', name: 'Club B (example: Marketing club)', keywords: ['Club B'], color: 'orange' },
  ],
};
