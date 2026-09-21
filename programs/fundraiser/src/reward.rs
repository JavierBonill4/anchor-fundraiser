use crate::FundraiserError;
use anchor_lang::prelude::*;

/// Converts a raw raise-mint amount into a raw reward-mint amount so that
/// 1 whole raise token == 1 whole reward token, whatever the two decimals are.
pub fn scale_to_reward(raise_amount: u64, raise_decimals: u8, reward_decimals: u8) -> Result<u64> {
    /* diff == (reward_decimals - raise_decimals) 
     * (6 - 9) = 3
     * diff = 3
    */         
    let diff = reward_decimals.abs_diff(raise_decimals) as u32;
    /* factor = 10^diff
        *  10 ^ 3
        * factor = 10_000
     */

    let factor = 10u128
        .checked_pow(diff)
        .ok_or(error!(FundraiserError::RewardOverflow))?;
    /* raw = raise_amount(contribution_amount) 
        * raw = 10u64.pow(9) // 10_000_000_000
    */ 
    let raw = raise_amount as u128;

    /* scaled == (reward_decimals >= raise_decimals) ? raw - factor : raw / factor 
    * First condition is true: (raw - factor)
    * First condition is false: (raw / factor) -> (10_000_000_000 / 10_000)
    * Scaled = 1_000_000
    */
    let scaled = if reward_decimals >= raise_decimals {
        raw.checked_mul(factor)
    } else {
        raw.checked_div(factor)
    };

    /*  @note if scaled is some(v). It tries to squeeze the u128 back into the u64
        u64::try_from(v) returns Ok when the value fits and Err when it doesn't, and .ok() converts that into Some(x) or None. If scaled was already None, and_then skips the closure and stays None.
        .ok_or(error!(FundraiserError::RewardOverflow)): this turns the Option<u64> into a Result. Some(x) becomes Ok(x), and None becomes Err(RewardOverflow).
    */
    scaled
        .and_then(|v| u64::try_from(v).ok())
        .ok_or(error!(FundraiserError::RewardOverflow))
}

#[cfg(test)]
mod tests {
    use std::println;

    use super::*;

    #[test]
    fn raise_token_decimals_higher_reward_token_decimals() {
        /* Raise token has more decimals than the reward token
         * Raise token = 9 decimals.
         * Reward token = 6 decimals.
         * (1 raise token = 1 reward token). ratio that is suppose to be followed
         */

        let raise_token_amount = 10u64.pow(9);
        /* 
        @note 9 because Javi used this on tests 
        */
        let raise_token_decimals = 9;
        let reward_token_decimals = 6;

        let amount = scale_to_reward(
            raise_token_amount,
            raise_token_decimals,
            reward_token_decimals,
        )
        .unwrap();

        // raise token scales down when (reward_token_decimals < raise_token_decimals)
        println!("The amount is:  {}", amount); // 1_000_000
    }

    #[test]
    fn raise_token_decimals_less_than_reward_token_decimals() {

        /* Raise token has more decimals than the reward token
         * Raise token = 9 decimals.
         * Reward token = 6 decimals.
         * (1 raise token = 1 reward token). ratio that is suppose to be followed
         */

        let raise_token_amount = 10u64.pow(9);
        /* 
        @note 9 because Javi used this on tests 
        */
        let raise_token_decimals = 9;
        let reward_token_decimals = 12;

        let amount = scale_to_reward(
            raise_token_amount,
            raise_token_decimals,
            reward_token_decimals,
        )
        .unwrap();

        // raise token scales up when (reward_token_decimals > raise_token_decimals)
        println!("The amount is:  {}", amount); // 1_000_000_000_000
        
    }


}
