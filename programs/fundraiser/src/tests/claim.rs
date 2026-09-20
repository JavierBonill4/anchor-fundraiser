use litesvm_token::{get_spl_account, spl_token::state::Mint};

use crate::{instructions::claim::reward_amount, FundraiserError, REWARD_DECIMALS, REWARD_RATE};

use super::campaign::{assert_error, Campaign, CONTRIBUTION, ONE_REWARD};

#[test]
fn reward_mint_has_9_decimals_and_the_fundraiser_as_authority() {
    let c = Campaign::new();
    let mint = get_spl_account::<Mint>(&c.svm, &c.reward_mint).unwrap();

    assert_eq!(mint.decimals, REWARD_DECIMALS);
    assert_eq!(mint.mint_authority.unwrap(), c.fundraiser);
    assert_eq!(mint.supply, 0);
}

#[test]
fn claim_mints_rewards_after_a_successful_campaign() {
    let mut c = Campaign::new();
    let contributors = c.fill_target();
    c.end_campaign();

    // The maker withdraws first: claim must not depend on what is left in the vault
    c.check_contributions().expect("check_contributions");

    for contributor in &contributors {
        c.claim(contributor).expect("claim");

        // 3 tokens with 6 decimals -> 3 rewards with 9 decimals
        assert_eq!(c.reward_balance(contributor), 3 * ONE_REWARD * REWARD_RATE);
        // One-shot: the contributor account is closed and its rent returned
        assert!(c.svm.get_account(&c.contributor_account(contributor)).map_or(true, |a| a.lamports == 0));
    }

    let mint = get_spl_account::<Mint>(&c.svm, &c.reward_mint).unwrap();
    assert_eq!(mint.supply, 30 * ONE_REWARD * REWARD_RATE);
}

#[test]
fn claim_is_refused_before_the_campaign_ends() {
    let mut c = Campaign::new();
    let contributors = c.fill_target();

    assert_error(c.claim(&contributors[0]), FundraiserError::FundraiserNotEnded.into());
}

#[test]
fn claim_is_refused_when_the_target_was_not_met() {
    let mut c = Campaign::new();
    let contributor = c.contributor(CONTRIBUTION);
    c.end_campaign();

    assert_error(c.claim(&contributor), FundraiserError::TargetNotMet.into());
}

#[test]
fn claim_is_refused_the_second_time() {
    let mut c = Campaign::new();
    let contributors = c.fill_target();
    c.end_campaign();

    c.claim(&contributors[0]).expect("first claim");

    assert_error(c.claim(&contributors[0]), anchor_lang::error::ErrorCode::AccountNotInitialized.into());
    assert_eq!(c.reward_balance(&contributors[0]), 3 * ONE_REWARD * REWARD_RATE);
}

// reward_amount on its own: decimal cases the end-to-end tests do not reach

#[test]
fn reward_amount_converts_one_token_into_one_reward() {
    // 6 -> 9 decimals scales up
    assert_eq!(reward_amount(1_000_000, 6, 9), Some(REWARD_RATE * ONE_REWARD));
    // same decimals: no scaling
    assert_eq!(reward_amount(1_000_000_000, 9, 9), Some(REWARD_RATE * ONE_REWARD));
    // 12 -> 9 decimals scales down
    assert_eq!(reward_amount(10u64.pow(12), 12, 9), Some(REWARD_RATE * ONE_REWARD));
}

#[test]
fn reward_amount_does_not_overflow_on_a_large_contribution() {
    // 100k USDC: amount * 10^9 is past u64::MAX, the result is not
    assert_eq!(reward_amount(100_000_000_000, 6, 9), Some(REWARD_RATE * 100_000 * ONE_REWARD));
}
