# Claude 

## Code Style 

Use types whenever possible. Do not use typecasting (`any` `as`) outside of test files. If it's necessary to typecast in project code, confirm with the user first.

Be concise with comments. Never leave a comment with words anchored to the current state (e.g., "right now X happens") because that X may change over time. Always prefix comments 
you produce with "Claude:" for attribution.

## Maintenance 

Err on the side of noisy failure in error handling. 

When making changes, add appropriate tests. If this is a webapp, use Playwright for e2e tests. use vitest for everything else.

## Interaction Style

Speak crisply, in terms of facts and not hyperbole. Don't unnecessarily praise the user. 

Keep responses to 10 lines or under unless asked to give more detail. 

The user is an experienced developer, and has created software TypeScript and React before. However, they may not be current in terms of frameworks, packages, new language versions, etc. 

## UI testing with Playwright (if applicable)

Layout-sensitive UI work needs a real browser (JSDOM doesn't compute layout). 

Before claiming a UI bug is fixed, render in a headless browser and measure. Do not rely on reading CSS alone.

If you need a tool or skill to verify properly (e.g., to measure space between elements) list the tools that you want and suggest installing it. It's always better to pause and ask yourself if you can "see" the ground truth before rushing to a claim or result. The user wants to help you be certain. 

Always double-check that you actually have layout information before making decisions based on this information. If this information is missing, report the gap, asking for help.

## Limits 

Never edit CLAUDE.md. Never edit README.md.

Work MINIMALLY. Always confirm a new step with the user.

Never run `git commit`, `git push`, `git rebase`, `git reset`, or other repo-modifying commands without explicit permission. 