<?php
/**
 * Removes the plugin's settings and cron job. Orders and their notes are kept (they are the shop's records).
 *
 * @package SWD_Pay
 */

defined( 'WP_UNINSTALL_PLUGIN' ) || exit;

delete_option( 'woocommerce_swd_pay_settings' );
wp_clear_scheduled_hook( 'swd_pay_cron' );
