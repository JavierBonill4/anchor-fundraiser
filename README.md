# Fundraiser Milestone Tracking

## What I Built

I added milestone tracking to the fundraiser program. The fundraiser now records when it reaches 25%, 50%, and 75% of its fundraising goal.

Each milestone is stored in the `milestones_fired` field so the program can remember which milestones have already been reached.

## How It Works

The program checks milestone progress after every successful contribution.

It calculates progress using integer math:

- 25% = first quarter
- 50% = second quarter
- 75% = third quarter

The program uses bits inside one `u8` value to track the milestones:

- `1` means the 25% milestone has fired
- `3` means the 25% and 50% milestones have fired
- `7` means all three milestones have fired

This makes sure each milestone is only recorded once.

## What It Costs

The feature adds one `u8` field to the `Fundraiser` account, so it only increases the account size by one byte.

It also adds a small amount of computation during each contribution because the program checks the fundraiser's progress after updating the contribution total.

## Where It Is Weak

The milestone system only records whether a milestone has been reached. It does not create a separate account or store the exact time when each milestone happened.

If the fundraiser total later changes because of another part of the program, the milestone flags do not automatically go backward. Once a milestone is marked as reached, it stays marked.

## How I Tested It

I added tests that check the on-chain `milestones_fired` value.

The tests verify that:

- A new fundraiser starts with no milestones fired.
- A fundraiser below 25% still has no milestones fired.
- Crossing 25% changes the milestone value to `1`.
- Reaching 50% changes the milestone value to `3`, showing that both the 25% and 50% milestones were recorded.

All original tests still pass along with the new milestone tests.