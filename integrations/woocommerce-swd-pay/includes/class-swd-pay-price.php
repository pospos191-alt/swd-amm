<?php
/**
 * Price quotes: how many tokens an order costs. Fixed rate (set by the merchant) or Jupiter's USD price.
 *
 * @package SWD_Pay
 */

defined( 'ABSPATH' ) || exit;

/**
 * Quotes.
 */
class SWD_Pay_Price {

	const JUPITER_PRICE_URL = 'https://lite-api.jup.ag/price/v3?ids=';

	/**
	 * Accepted tokens: key => [ symbol, mint, decimals ].
	 *
	 * @return array
	 */
	public static function tokens() {
		return array(
			'swd'  => array(
				'symbol'   => 'SWD',
				'mint'     => 'Cmh2tu6bt5z2a8NKsx6G5WfVmaeQ9f2fcX5VnQbVaGLL',
				'decimals' => 5,
			),
			'usdc' => array(
				'symbol'   => 'USDC',
				'mint'     => 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
				'decimals' => 6,
			),
		);
	}

	/**
	 * Store-currency price of one whole token, as a decimal string, or null.
	 *
	 * @param string        $key       Token key (swd | usdc).
	 * @param array         $settings  Gateway settings.
	 * @param callable|null $fetch_usd Callable( string $mint ): ?float USD price (default: Jupiter).
	 * @return string|null
	 */
	public static function unit_price( $key, $settings, $fetch_usd = null ) {
		$tokens = self::tokens();
		if ( ! isset( $tokens[ $key ] ) ) {
			return null;
		}
		$mode = isset( $settings['pricing'] ) ? $settings['pricing'] : 'fixed';
		if ( 'fixed' === $mode ) {
			$p = isset( $settings[ 'price_' . $key ] ) ? trim( (string) $settings[ 'price_' . $key ] ) : '';
			return SWD_Pay_Math::is_decimal( $p, 12 ) && '0' !== SWD_Pay_Math::scale( $p, 12 ) ? $p : null;
		}
		$rate = isset( $settings['usd_rate'] ) ? trim( (string) $settings['usd_rate'] ) : '1';
		if ( ! SWD_Pay_Math::is_decimal( $rate, 12 ) || '0' === SWD_Pay_Math::scale( $rate, 12 ) ) {
			return null;
		}
		$usd = call_user_func( $fetch_usd ? $fetch_usd : array( __CLASS__, 'jupiter_usd' ), $tokens[ $key ]['mint'] );
		if ( null === $usd ) {
			return null;
		}
		return SWD_Pay_Math::float_to_decimal( (float) $usd * (float) $rate );
	}

	/**
	 * Jupiter Price API v3 (USD), cached 60 s.
	 *
	 * @param string $mint Mint.
	 * @return float|null
	 */
	public static function jupiter_usd( $mint ) {
		$ck  = 'swd_pay_px_' . md5( $mint );
		$hit = get_transient( $ck );
		if ( false !== $hit ) {
			return (float) $hit;
		}
		$r = wp_safe_remote_get(
			self::JUPITER_PRICE_URL . rawurlencode( $mint ),
			array(
				'timeout'     => 10,
				'redirection' => 0,
			)
		);
		if ( is_wp_error( $r ) || 200 !== (int) wp_remote_retrieve_response_code( $r ) ) {
			return null;
		}
		$j = json_decode( wp_remote_retrieve_body( $r ), true );
		if ( ! is_array( $j ) || empty( $j[ $mint ]['usdPrice'] ) || ! is_numeric( $j[ $mint ]['usdPrice'] ) ) {
			return null;
		}
		$usd = (float) $j[ $mint ]['usdPrice'];
		if ( $usd <= 0 || ! is_finite( $usd ) ) {
			return null;
		}
		set_transient( $ck, (string) $usd, 60 );
		return $usd;
	}

	/**
	 * Quotes for every accepted token.
	 *
	 * @param string        $total     Order total (decimal string, store currency).
	 * @param array         $settings  Gateway settings.
	 * @param int           $now       Unix time.
	 * @param callable|null $fetch_usd See unit_price().
	 * @return array List of [ key, symbol, mint, decimals, raw, amount, price, until ].
	 */
	public static function quotes( $total, $settings, $now, $fetch_usd = null ) {
		$out     = array();
		$minutes = isset( $settings['quote_minutes'] ) ? max( 5, min( 120, (int) $settings['quote_minutes'] ) ) : 15;
		foreach ( self::tokens() as $key => $t ) {
			if ( empty( $settings[ 'accept_' . $key ] ) || 'yes' !== $settings[ 'accept_' . $key ] ) {
				continue;
			}
			$price = self::unit_price( $key, $settings, $fetch_usd );
			if ( null === $price ) {
				continue;
			}
			$raw = SWD_Pay_Math::token_raw_amount( $total, $price, $t['decimals'] );
			if ( null === $raw ) {
				continue;
			}
			$out[] = array(
				'key'      => $key,
				'symbol'   => $t['symbol'],
				'mint'     => $t['mint'],
				'decimals' => $t['decimals'],
				'raw'      => $raw,
				'amount'   => SWD_Pay_Math::format_raw( $raw, $t['decimals'] ),
				'price'    => $price,
				'at'       => $now,
				// A market-price quote expires; a fixed rate does not.
				'until'    => ( isset( $settings['pricing'] ) && 'jupiter' === $settings['pricing'] ) ? $now + 60 * $minutes : 0,
			);
		}
		return $out;
	}

	/**
	 * Solana Pay transfer request URL.
	 *
	 * @param string $recipient Wallet.
	 * @param array  $quote     One quote.
	 * @param string $reference Reference key.
	 * @param string $label     Shop name.
	 * @param string $message   e.g. "Order #123".
	 * @return string
	 */
	public static function solana_pay_url( $recipient, $quote, $reference, $label, $message ) {
		return 'solana:' . $recipient . '?' . http_build_query(
			array(
				'amount'    => $quote['amount'],
				'spl-token' => $quote['mint'],
				'reference' => $reference,
				'label'     => $label,
				'message'   => $message,
			),
			'',
			'&',
			PHP_QUERY_RFC3986
		);
	}
}
