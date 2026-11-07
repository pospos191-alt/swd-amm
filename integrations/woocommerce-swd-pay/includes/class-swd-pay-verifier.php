<?php
/**
 * Decides whether one Solana transaction pays an order. Pure: it reads a `getTransaction` (jsonParsed) result and
 * the order's expectations, nothing else. tests/run.php feeds it fixtures.
 *
 * @package SWD_Pay
 */

defined( 'ABSPATH' ) || exit;

/**
 * Transaction matcher.
 */
class SWD_Pay_Verifier {

	/**
	 * Checks a transaction against an order.
	 *
	 * @param array $tx     `getTransaction` result (encoding jsonParsed), decoded as arrays.
	 * @param array $expect {
	 *     The order's expectations.
	 *
	 *     @type string $reference The order's reference key (must be one of the transaction's accounts).
	 *     @type string $recipient The merchant wallet (token account OWNER).
	 *     @type array  $quotes    List of [ 'mint' => string, 'decimals' => int, 'raw' => string, 'until' => ?int ]
	 *                             the order accepts (`until`: unix time the quote expires, 0 = never).
	 *     @type int    $not_before Unix time; a transaction older than this (minus 10 minutes) is refused.
	 * }
	 * @return array [ 'ok' => bool, 'reason' => string, 'mint' => ?string, 'received' => ?string ]
	 *               reason: paid | failed | no_reference | too_old | underpaid | no_transfer
	 */
	public static function check( $tx, $expect ) {
		$out = array(
			'ok'       => false,
			'reason'   => 'no_transfer',
			'mint'     => null,
			'received' => null,
		);
		if ( ! is_array( $tx ) || empty( $tx['meta'] ) || ! is_array( $tx['meta'] ) ) {
			$out['reason'] = 'no_transfer';
			return $out;
		}
		if ( ! empty( $tx['meta']['err'] ) ) {
			$out['reason'] = 'failed';
			return $out;
		}
		$keys = array();
		if ( isset( $tx['transaction']['message']['accountKeys'] ) && is_array( $tx['transaction']['message']['accountKeys'] ) ) {
			foreach ( $tx['transaction']['message']['accountKeys'] as $k ) {
				$keys[] = is_array( $k ) ? ( isset( $k['pubkey'] ) ? $k['pubkey'] : '' ) : (string) $k;
			}
		}
		if ( ! in_array( $expect['reference'], $keys, true ) ) {
			$out['reason'] = 'no_reference';
			return $out;
		}
		if ( ! empty( $expect['not_before'] ) && isset( $tx['blockTime'] ) && (int) $tx['blockTime'] < (int) $expect['not_before'] - 600 ) {
			$out['reason'] = 'too_old';
			return $out;
		}
		$best_under = null;
		foreach ( $expect['quotes'] as $q ) {
			// A price quote is honoured only until it expires (fixed-rate quotes have no `until`).
			if ( ! empty( $q['until'] ) && isset( $tx['blockTime'] ) && (int) $tx['blockTime'] > (int) $q['until'] ) {
				continue;
			}
			$delta = self::received( $tx['meta'], $expect['recipient'], $q['mint'], (int) $q['decimals'] );
			if ( null === $delta || '0' === $delta ) {
				continue;
			}
			if ( SWD_Pay_Math::cmp( $delta, $q['raw'] ) >= 0 ) {
				return array(
					'ok'       => true,
					'reason'   => 'paid',
					'mint'     => $q['mint'],
					'received' => $delta,
				);
			}
			$best_under = array(
				'ok'       => false,
				'reason'   => 'underpaid',
				'mint'     => $q['mint'],
				'received' => $delta,
			);
		}
		return $best_under ? $best_under : $out;
	}

	/**
	 * How much of `mint` the token accounts OWNED by `owner` gained in this transaction (raw units, string), or null
	 * if the decimals do not match / nothing arrived.
	 *
	 * @param array  $meta     Transaction meta.
	 * @param string $owner    Wallet.
	 * @param string $mint     Mint.
	 * @param int    $decimals Expected decimals.
	 * @return string|null
	 */
	public static function received( $meta, $owner, $mint, $decimals ) {
		$sum  = function ( $balances ) use ( $owner, $mint, $decimals ) {
			$total = 0;
			$bad   = false;
			foreach ( is_array( $balances ) ? $balances : array() as $b ) {
				if ( ! is_array( $b ) || ( isset( $b['owner'] ) ? $b['owner'] : '' ) !== $owner || ( isset( $b['mint'] ) ? $b['mint'] : '' ) !== $mint ) {
					continue;
				}
				$ui = isset( $b['uiTokenAmount'] ) ? $b['uiTokenAmount'] : array();
				if ( ! isset( $ui['decimals'] ) || (int) $ui['decimals'] !== $decimals || ! isset( $ui['amount'] ) || ! preg_match( '/^\d{1,18}$/', (string) $ui['amount'] ) ) {
					$bad = true;
					continue;
				}
				$total += (int) $ui['amount'];
			}
			return $bad ? null : $total;
		};
		$pre  = $sum( isset( $meta['preTokenBalances'] ) ? $meta['preTokenBalances'] : array() );
		$post = $sum( isset( $meta['postTokenBalances'] ) ? $meta['postTokenBalances'] : array() );
		if ( null === $pre || null === $post || $post <= $pre ) {
			return null;
		}
		return (string) ( $post - $pre );
	}
}
