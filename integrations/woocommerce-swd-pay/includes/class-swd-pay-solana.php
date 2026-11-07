<?php
/**
 * A minimal Solana JSON-RPC client: finds a paying transaction for an order's reference key.
 *
 * The HTTP transport is injectable (tests/run.php uses a fake); in WordPress it is wp_remote_post.
 *
 * @package SWD_Pay
 */

defined( 'ABSPATH' ) || exit;

/**
 * RPC client.
 */
class SWD_Pay_Solana {

	/**
	 * RPC URL.
	 *
	 * @var string
	 */
	private $rpc;

	/**
	 * Commitment: confirmed | finalized.
	 *
	 * @var string
	 */
	private $commitment;

	/**
	 * Callable( string $url, string $json_body ): ?string response body.
	 *
	 * @var callable
	 */
	private $transport;

	/**
	 * Constructor.
	 *
	 * @param string        $rpc        RPC URL (https).
	 * @param string        $commitment confirmed | finalized.
	 * @param callable|null $transport  Optional transport.
	 */
	public function __construct( $rpc, $commitment = 'confirmed', $transport = null ) {
		$this->rpc        = $rpc;
		$this->commitment = 'finalized' === $commitment ? 'finalized' : 'confirmed';
		$this->transport  = $transport ? $transport : array( __CLASS__, 'wp_transport' );
	}

	/**
	 * WordPress HTTP transport.
	 *
	 * @param string $url  URL.
	 * @param string $body JSON.
	 * @return string|null
	 */
	public static function wp_transport( $url, $body ) {
		$r = wp_safe_remote_post(
			$url,
			array(
				'timeout'     => 15,
				'redirection' => 0,
				'headers'     => array( 'Content-Type' => 'application/json' ),
				'body'        => $body,
				'user-agent'  => 'swd-pay-woocommerce/' . ( defined( 'SWD_PAY_VERSION' ) ? SWD_PAY_VERSION : 'dev' ),
			)
		);
		if ( is_wp_error( $r ) || 200 !== (int) wp_remote_retrieve_response_code( $r ) ) {
			return null;
		}
		return wp_remote_retrieve_body( $r );
	}

	/**
	 * One JSON-RPC call.
	 *
	 * @param string $method Method.
	 * @param array  $params Params.
	 * @return mixed The result.
	 * @throws RuntimeException On a transport or RPC error.
	 */
	public function call( $method, $params ) {
		$body = wp_json_encode(
			array(
				'jsonrpc' => '2.0',
				'id'      => 1,
				'method'  => $method,
				'params'  => $params,
			)
		);
		$raw  = call_user_func( $this->transport, $this->rpc, $body );
		$json = is_string( $raw ) ? json_decode( $raw, true ) : null;
		if ( ! is_array( $json ) || isset( $json['error'] ) || ! array_key_exists( 'result', $json ) ) {
			throw new RuntimeException( 'rpc_error' );
		}
		return $json['result'];
	}

	/**
	 * Looks for a transaction that pays the order.
	 *
	 * @param array $expect See SWD_Pay_Verifier::check(). Also `used`: callable( string $signature ): bool, true when
	 *                      the signature already paid ANOTHER order (one transaction can carry several references).
	 * @return array [ 'status' => 'paid'|'underpaid'|'pending', 'signature' => ?string, 'mint' => ?string, 'received' => ?string ]
	 * @throws RuntimeException On an RPC error.
	 */
	public function find_payment( $expect ) {
		$sigs   = $this->call(
			'getSignaturesForAddress',
			array(
				$expect['reference'],
				array(
					'limit'      => 20,
					'commitment' => $this->commitment,
				),
			)
		);
		$result = array(
			'status'    => 'pending',
			'signature' => null,
			'mint'      => null,
			'received'  => null,
		);
		foreach ( is_array( $sigs ) ? $sigs : array() as $s ) {
			if ( ! is_array( $s ) || empty( $s['signature'] ) || ! empty( $s['err'] ) ) {
				continue;
			}
			$sig = (string) $s['signature'];
			if ( ! preg_match( '/^[1-9A-HJ-NP-Za-km-z]{64,90}$/', $sig ) ) {
				continue;
			}
			if ( isset( $expect['used'] ) && call_user_func( $expect['used'], $sig ) ) {
				continue;
			}
			$tx = $this->call(
				'getTransaction',
				array(
					$sig,
					array(
						'encoding'                       => 'jsonParsed',
						'commitment'                     => $this->commitment,
						'maxSupportedTransactionVersion' => 0,
					),
				)
			);
			$m  = SWD_Pay_Verifier::check( $tx, $expect );
			if ( $m['ok'] ) {
				return array(
					'status'    => 'paid',
					'signature' => $sig,
					'mint'      => $m['mint'],
					'received'  => $m['received'],
				);
			}
			if ( 'underpaid' === $m['reason'] ) {
				$result = array(
					'status'    => 'underpaid',
					'signature' => $sig,
					'mint'      => $m['mint'],
					'received'  => $m['received'],
				);
			}
		}
		return $result;
	}
}
