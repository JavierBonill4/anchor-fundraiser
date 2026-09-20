// Test fixture: a fundraiser already initialized in LiteSVM, plus helpers that
// send the program's instructions. Assertions stay in the tests.

use anchor_lang::{
    prelude::{Clock, Pubkey},
    solana_program::instruction::Instruction,
    InstructionData, ToAccountMetas,
};
use anchor_spl::associated_token::get_associated_token_address;
use litesvm::LiteSVM;
use litesvm_token::{
    get_spl_account,
    spl_token::state::Account as TokenAccount,
    CreateAssociatedTokenAccount, CreateMint, MintTo,
};
use solana_keypair::Keypair;
use solana_signer::Signer;
use solana_transaction::Transaction;

use crate::{REWARD_DECIMALS, SECONDS_TO_DAYS};

pub const RAISE_DECIMALS: u8 = 6;
pub const ONE_TOKEN: u64 = 10u64.pow(RAISE_DECIMALS as u32);
pub const ONE_REWARD: u64 = 10u64.pow(REWARD_DECIMALS as u32);
// 30 tokens with a 10% cap per contributor: ten contributors of 3 fill it
pub const TARGET: u64 = 30 * ONE_TOKEN;
pub const CONTRIBUTION: u64 = 3 * ONE_TOKEN;
pub const DURATION_DAYS: u8 = 1;

pub struct Campaign {
    pub svm: LiteSVM,
    pub maker: Keypair,
    pub mint: Pubkey,
    pub fundraiser: Pubkey,
    pub vault: Pubkey,
    pub reward_mint: Pubkey,
}

impl Campaign {
    pub fn new() -> Self {
        let mut svm = LiteSVM::new();
        let so = concat!(env!("CARGO_MANIFEST_DIR"), "/../../target/deploy/fundraiser.so");
        svm.add_program_from_file(crate::ID, so)
            .expect("fundraiser.so not found, run `anchor build` first");

        let maker = Keypair::new();
        svm.airdrop(&maker.pubkey(), 10_000_000_000).unwrap();

        let mint = CreateMint::new(&mut svm, &maker).decimals(RAISE_DECIMALS).send().unwrap();

        let fundraiser = Pubkey::find_program_address(&[b"fundraiser", maker.pubkey().as_ref()], &crate::ID).0;
        let vault = get_associated_token_address(&fundraiser, &mint);
        let reward_mint = Pubkey::find_program_address(&[b"reward", fundraiser.as_ref()], &crate::ID).0;

        let mut campaign = Campaign { svm, maker, mint, fundraiser, vault, reward_mint };

        let ix = campaign.ix(
            crate::accounts::Initialize {
                maker: campaign.maker.pubkey(),
                mint_to_raise: mint,
                fundraiser,
                vault,
                reward_mint,
                system_program: anchor_lang::system_program::ID,
                token_program: anchor_spl::token::ID,
                associated_token_program: anchor_spl::associated_token::ID,
            },
            crate::instruction::Initialize { amount: TARGET, duration: DURATION_DAYS },
        );
        let maker = campaign.maker.insecure_clone();
        campaign.send(ix, &maker).expect("initialize");

        campaign
    }

    fn ix(&self, accounts: impl ToAccountMetas, data: impl InstructionData) -> Instruction {
        Instruction { program_id: crate::ID, accounts: accounts.to_account_metas(None), data: data.data() }
    }

    // Expires the blockhash after each send, so sending the same instruction
    // twice is a real second attempt and not rejected as a duplicate.
    fn send(&mut self, ix: Instruction, signer: &Keypair) -> Result<(), String> {
        let tx = Transaction::new_signed_with_payer(
            &[ix],
            Some(&signer.pubkey()),
            &[signer],
            self.svm.latest_blockhash(),
        );
        let result = self.svm.send_transaction(tx).map(|_| ()).map_err(|e| format!("{:?}", e.err));
        self.svm.expire_blockhash();
        result
    }

    // A funded contributor that has already contributed `amount`
    pub fn contributor(&mut self, amount: u64) -> Keypair {
        let contributor = Keypair::new();
        self.svm.airdrop(&contributor.pubkey(), 10_000_000_000).unwrap();

        let ata = CreateAssociatedTokenAccount::new(&mut self.svm, &contributor, &self.mint)
            .send()
            .unwrap();
        MintTo::new(&mut self.svm, &self.maker, &self.mint, &ata, amount).send().unwrap();

        let ix = self.ix(
            crate::accounts::Contribute {
                contributor: contributor.pubkey(),
                mint_to_raise: self.mint,
                fundraiser: self.fundraiser,
                contributor_account: self.contributor_account(&contributor),
                contributor_ata: ata,
                vault: self.vault,
                token_program: anchor_spl::token::ID,
                system_program: anchor_lang::system_program::ID,
            },
            crate::instruction::Contribute { amount },
        );
        self.send(ix, &contributor).expect("contribute");

        contributor
    }

    pub fn contributor_account(&self, contributor: &Keypair) -> Pubkey {
        Pubkey::find_program_address(
            &[b"contributor", self.fundraiser.as_ref(), contributor.pubkey().as_ref()],
            &crate::ID,
        )
        .0
    }

    pub fn fill_target(&mut self) -> Vec<Keypair> {
        (0..TARGET / CONTRIBUTION).map(|_| self.contributor(CONTRIBUTION)).collect()
    }

    pub fn end_campaign(&mut self) {
        let mut clock: Clock = self.svm.get_sysvar();
        clock.unix_timestamp += DURATION_DAYS as i64 * SECONDS_TO_DAYS + 1;
        self.svm.set_sysvar(&clock);
    }

    pub fn check_contributions(&mut self) -> Result<(), String> {
        let ix = self.ix(
            crate::accounts::CheckContributions {
                maker: self.maker.pubkey(),
                mint_to_raise: self.mint,
                fundraiser: self.fundraiser,
                vault: self.vault,
                maker_ata: get_associated_token_address(&self.maker.pubkey(), &self.mint),
                token_program: anchor_spl::token::ID,
                system_program: anchor_lang::system_program::ID,
                associated_token_program: anchor_spl::associated_token::ID,
            },
            crate::instruction::CheckContributions {},
        );
        let maker = self.maker.insecure_clone();
        self.send(ix, &maker)
    }

    pub fn claim(&mut self, contributor: &Keypair) -> Result<(), String> {
        let ix = self.ix(
            crate::accounts::ClaimTokenReward {
                contributor: contributor.pubkey(),
                mint_to_raise: self.mint,
                fundraiser: self.fundraiser,
                contributor_account: self.contributor_account(contributor),
                reward_mint: self.reward_mint,
                contributor_reward_ata: self.reward_ata(contributor),
                token_program: anchor_spl::token::ID,
                associated_token_program: anchor_spl::associated_token::ID,
                system_program: anchor_lang::system_program::ID,
            },
            crate::instruction::ClaimTokenReward {},
        );
        self.send(ix, contributor)
    }

    pub fn reward_ata(&self, contributor: &Keypair) -> Pubkey {
        get_associated_token_address(&contributor.pubkey(), &self.reward_mint)
    }

    pub fn reward_balance(&self, contributor: &Keypair) -> u64 {
        get_spl_account::<TokenAccount>(&self.svm, &self.reward_ata(contributor)).unwrap().amount
    }
}

pub fn assert_error(result: Result<(), String>, code: u32) {
    let err = result.expect_err("the transaction should have failed");
    assert!(err.contains(&format!("Custom({code})")), "expected error {code}, got {err}");
}
