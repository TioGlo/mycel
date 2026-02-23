/**
 * Sweep all funds from the Mycel wallet to the operator's wallet.
 * 1. Claim MYCEL fees from Clanker fee locker
 * 2. Send any MYCEL tokens to destination
 * 3. Send remaining ETH (minus gas) to destination
 */

import { createWalletClient, createPublicClient, http, parseAbi, formatEther, formatUnits } from 'viem';
import { base } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';

const DESTINATION = '0x80FeADE93EeE188F68897d5367fb75533EfB76Cd';

const FEE_LOCKER = '0xF3622742b1E446D92e45E22923Ef11C2fcD55D68';
const MYCEL = '0x94222fbc9ff779f7b02E77B60411BBAC6420f1B3';
const FEE_OWNER = '0x9FffCdb0bB65Ac66D20179A4874fD965F1b1b2be';

const feeLockerAbi = parseAbi([
  'function availableFees(address feeOwner, address token) view returns (uint256)',
  'function claim(address feeOwner, address token) external',
]);

const erc20Abi = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)',
]);

const pk = process.env.DAIMON_WALLET_KEY;
if (!pk) { console.error('DAIMON_WALLET_KEY not set'); process.exit(1); }

const account = privateKeyToAccount(pk.startsWith('0x') ? pk : `0x${pk}`);
console.log(`Wallet:      ${account.address}`);
console.log(`Destination: ${DESTINATION}\n`);

const transport = http('https://mainnet.base.org');
const publicClient = createPublicClient({ chain: base, transport });
const walletClient = createWalletClient({ account, chain: base, transport });

// --- Step 1: Claim MYCEL fees ---
try {
  const claimable = await publicClient.readContract({
    address: FEE_LOCKER, abi: feeLockerAbi,
    functionName: 'availableFees', args: [FEE_OWNER, MYCEL],
  });
  if (claimable > 0n) {
    console.log(`Claimable MYCEL: ${formatUnits(claimable, 18)}`);
    const hash = await walletClient.writeContract({
      address: FEE_LOCKER, abi: feeLockerAbi,
      functionName: 'claim', args: [FEE_OWNER, MYCEL],
    });
    console.log(`Claim tx: ${hash}`);
    await publicClient.waitForTransactionReceipt({ hash });
    console.log('Claim confirmed ✓\n');
  } else {
    console.log('No MYCEL fees to claim.\n');
  }
} catch (e) {
  console.log(`Fee claim failed (non-fatal): ${e.shortMessage || e.message}\n`);
}

// --- Step 2: Send MYCEL tokens ---
try {
  const mycelBal = await publicClient.readContract({
    address: MYCEL, abi: erc20Abi,
    functionName: 'balanceOf', args: [account.address],
  });
  if (mycelBal > 0n) {
    console.log(`MYCEL balance: ${formatUnits(mycelBal, 18)}`);
    const hash = await walletClient.writeContract({
      address: MYCEL, abi: erc20Abi,
      functionName: 'transfer', args: [DESTINATION, mycelBal],
    });
    console.log(`MYCEL transfer tx: ${hash}`);
    await publicClient.waitForTransactionReceipt({ hash });
    console.log('MYCEL sent ✓\n');
  } else {
    console.log('No MYCEL in wallet.\n');
  }
} catch (e) {
  console.log(`MYCEL transfer failed (non-fatal): ${e.shortMessage || e.message}\n`);
}

// --- Step 3: Sweep ETH ---
try {
  const balance = await publicClient.getBalance({ address: account.address });
  console.log(`ETH balance: ${formatEther(balance)}`);

  if (balance === 0n) {
    console.log('No ETH to sweep.');
    process.exit(0);
  }

  // Estimate gas for a simple transfer — leave generous buffer
  const gasPrice = await publicClient.getGasPrice();
  const gasLimit = 21000n;
  const gasCost = gasPrice * gasLimit * 3n; // 3x buffer for safety
  const sendAmount = balance - gasCost;

  if (sendAmount <= 0n) {
    console.log('Balance too low to cover gas. Nothing to sweep.');
    process.exit(0);
  }

  console.log(`Sending: ${formatEther(sendAmount)} ETH (keeping ${formatEther(balance - sendAmount)} for gas)`);

  const hash = await walletClient.sendTransaction({
    to: DESTINATION,
    value: sendAmount,
    gas: 21000n,
  });
  console.log(`ETH transfer tx: ${hash}`);
  await publicClient.waitForTransactionReceipt({ hash });
  console.log('ETH sent ✓');

  const remaining = await publicClient.getBalance({ address: account.address });
  console.log(`\nRemaining balance: ${formatEther(remaining)} ETH`);
  console.log('\n🍄 Sweep complete. Goodbye, Mycel.');
} catch (e) {
  console.error(`ETH sweep failed: ${e.shortMessage || e.message}`);
  process.exit(1);
}
