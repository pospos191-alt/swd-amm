<?php
/**
 * Exact amount math (decimal strings, no floats) and base58.
 *
 * No WordPress dependency, so tests/run.php can load it on its own.
 *
 * @package SWD_Pay
 */

defined( 'ABSPATH' ) || exit;

/**
 * Pure helpers.
 */
class SWD_Pay_Math {

	const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

	/**
	 * Base58 (Bitcoin alphabet) of raw bytes.
	 *
	 * @param string $bytes Raw bytes.
	 * @return string
	 */
	public static function base58_encode( $bytes ) {
		$digits = array(); // Base-58 digits, least significant first.
		$len    = strlen( $bytes );
		for ( $i = 0; $i < $len; $i++ ) {
			$carry = ord( $bytes[ $i ] );
			$count = count( $digits );
			for ( $j = 0; $j < $count; $j++ ) {
				$carry       += $digits[ $j ] << 8;
				$digits[ $j ] = $carry % 58;
				$carry        = intdiv( $carry, 58 );
			}
			while ( $carry > 0 ) {
				$digits[] = $carry % 58;
				$carry    = intdiv( $carry, 58 );
			}
		}
		$out = '';
		for ( $i = 0; $i < $len && "\0" === $bytes[ $i ]; $i++ ) {
			$out .= '1';
		}
		for ( $j = count( $digits ) - 1; $j >= 0; $j-- ) {
			$out .= self::B58[ $digits[ $j ] ];
		}
		return $out;
	}

	/**
	 * A new Solana Pay reference: 32 random bytes, base58.
	 *
	 * @return string
	 */
	public static function new_reference() {
		return self::base58_encode( random_bytes( 32 ) );
	}

	/**
	 * Is this a Solana address (base58, 32 to 44 characters)?
	 *
	 * @param mixed $s Value.
	 * @return bool
	 */
	public static function is_address( $s ) {
		return is_string( $s ) && 1 === preg_match( '/^[1-9A-HJ-NP-Za-km-z]{32,44}$/', $s );
	}

	/**
	 * Is this a plain non-negative decimal ("12", "0.000123")?
	 *
	 * @param mixed $s   Value.
	 * @param int   $max_decimals Maximum digits after the point.
	 * @return bool
	 */
	public static function is_decimal( $s, $max_decimals = 12 ) {
		return is_string( $s ) && 1 === preg_match( '/^\d{1,12}(\.\d{1,' . (int) $max_decimals . '})?$/', $s );
	}

	/**
	 * A decimal string as an integer string scaled by 10^scale ("1.5", 3 → "1500"). The decimal must not have more
	 * digits than `scale` after the point.
	 *
	 * @param string $s     Decimal.
	 * @param int    $scale Scale.
	 * @return string
	 */
	public static function scale( $s, $scale ) {
		$parts = explode( '.', $s );
		$whole = $parts[0];
		$frac  = isset( $parts[1] ) ? $parts[1] : '';
		$int   = ltrim( $whole . str_pad( $frac, $scale, '0' ), '0' );
		return '' === $int ? '0' : $int;
	}

	/**
	 * Ceiling division: ceil( a / b ) for a non-negative integer string `a` and a positive int `b` (b ≤ 10^15), as a string.
	 *
	 * @param string $a Dividend digits.
	 * @param int    $b Divisor.
	 * @return string
	 */
	public static function div_ceil( $a, $b ) {
		$q   = '';
		$rem = 0;
		$len = strlen( $a );
		for ( $i = 0; $i < $len; $i++ ) {
			$rem = $rem * 10 + (int) $a[ $i ];
			$q  .= (string) intdiv( $rem, $b );
			$rem = $rem % $b;
		}
		$q = ltrim( $q, '0' );
		$q = '' === $q ? '0' : $q;
		return $rem > 0 ? self::add_one( $q ) : $q;
	}

	/**
	 * Integer string + 1.
	 *
	 * @param string $s Digits.
	 * @return string
	 */
	public static function add_one( $s ) {
		$i = strlen( $s ) - 1;
		while ( $i >= 0 && '9' === $s[ $i ] ) {
			$s[ $i ] = '0';
			--$i;
		}
		return $i < 0 ? '1' . $s : substr( $s, 0, $i ) . (string) ( (int) $s[ $i ] + 1 ) . substr( $s, $i + 1 );
	}

	/**
	 * Compares two non-negative integer strings: -1, 0 or 1.
	 *
	 * @param string $a A.
	 * @param string $b B.
	 * @return int
	 */
	public static function cmp( $a, $b ) {
		$a = ltrim( $a, '0' );
		$b = ltrim( $b, '0' );
		if ( strlen( $a ) !== strlen( $b ) ) {
			return strlen( $a ) < strlen( $b ) ? -1 : 1;
		}
		return $a === $b ? 0 : ( $a < $b ? -1 : 1 );
	}

	/**
	 * The token amount (smallest units, rounded UP so the merchant is never short) for an order total.
	 *
	 * @param string $total    Order total in the store currency, decimal string (at most 8 decimals).
	 * @param string $price    Store currency per 1 whole token, decimal string (at most 12 decimals, > 0).
	 * @param int    $decimals Token decimals (0..12).
	 * @return string|null Raw amount, or null on bad input.
	 */
	public static function token_raw_amount( $total, $price, $decimals ) {
		if ( ! self::is_decimal( $total, 8 ) || ! self::is_decimal( $price, 12 ) || $decimals < 0 || $decimals > 12 ) {
			return null;
		}
		// raw = total * 10^decimals / price = (T / 10^8) * 10^decimals / (P / 10^12) = T * 10^(decimals + 4) / P.
		$p = self::scale( $price, 12 );
		if ( '0' === $p || strlen( $p ) > 15 ) {
			return null;
		}
		$t = self::scale( $total, 8 );
		if ( '0' === $t ) {
			return null;
		}
		return self::div_ceil( $t . str_repeat( '0', $decimals + 4 ), (int) $p );
	}

	/**
	 * Raw amount → decimal string for people and for the Solana Pay URL ("1234500", 5 → "12.345").
	 *
	 * @param string $raw      Integer string.
	 * @param int    $decimals Decimals.
	 * @return string
	 */
	public static function format_raw( $raw, $decimals ) {
		$raw = ltrim( (string) $raw, '0' );
		if ( 0 === $decimals ) {
			return '' === $raw ? '0' : $raw;
		}
		$raw   = str_pad( $raw, $decimals + 1, '0', STR_PAD_LEFT );
		$whole = substr( $raw, 0, -$decimals );
		$frac  = rtrim( substr( $raw, -$decimals ), '0' );
		return '' === $frac ? $whole : $whole . '.' . $frac;
	}

	/**
	 * A positive float price → decimal string with up to 12 decimals, or null if it rounds to zero / is not finite.
	 *
	 * @param mixed $f Number.
	 * @return string|null
	 */
	public static function float_to_decimal( $f ) {
		if ( ! is_numeric( $f ) || ! is_finite( (float) $f ) || (float) $f <= 0 || (float) $f >= 1e12 ) {
			return null;
		}
		$s = rtrim( rtrim( sprintf( '%.12F', (float) $f ), '0' ), '.' );
		return ( '0' === $s || '' === $s ) ? null : $s;
	}
}
