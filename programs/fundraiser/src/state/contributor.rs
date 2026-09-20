use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct Contributor {
    pub amount: u64, // track how much someone contributed, sould-bound receipt token can be good alternative  like in Option D
}
