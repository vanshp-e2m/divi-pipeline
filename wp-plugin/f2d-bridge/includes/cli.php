<?php
/**
 * wp f2d … — the pipeline's only write path into WordPress. Every command prints one JSON object.
 */
if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

class F2D_CLI {

	private function out( $data ) {
		if ( is_wp_error( $data ) ) {
			WP_CLI::line( wp_json_encode( array( 'ok' => false, 'error' => $data->get_error_code(), 'message' => $data->get_error_message() ) ) );
			WP_CLI::halt( 1 );
		}
		WP_CLI::line( wp_json_encode( array( 'ok' => true, 'data' => $data ) ) );
	}

	private function read_file( $path ) {
		if ( ! is_readable( $path ) ) {
			WP_CLI::error( "Cannot read {$path}" );
		}
		return file_get_contents( $path );
	}

	/**
	 * Environment facts the pipeline checks before building.
	 *
	 * @subcommand status
	 */
	public function status( $args, $assoc ) {
		$theme = wp_get_theme();
		$this->out(
			array(
				'bridge'      => F2D_BRIDGE_VERSION,
				'wp'          => get_bloginfo( 'version' ),
				'divi'        => f2d_divi_version(),
				'divi_active' => function_exists( 'et_pb_is_pagebuilder_used' ),
				'theme'       => $theme->get_stylesheet(),
				'block_theme' => function_exists( 'wp_is_block_theme' ) ? wp_is_block_theme() : null,
				'environment' => wp_get_environment_type(),
				'home'        => home_url( '/' ),
				'preview'     => f2d_preview_allowed(),
				'php'         => PHP_VERSION,
			)
		);
	}

	/**
	 * Create or update the generated draft page for a page key.
	 *
	 * ## OPTIONS
	 * --key=<page_key>
	 * --title=<title>
	 * --content-file=<path>
	 * --css-file=<path>
	 * --build-id=<id>
	 * [--slug=<slug>]
	 * [--status=<status>]
	 * [--allow-publish]
	 * [--fonts-file=<path>]
	 */
	public function deploy( $args, $assoc ) {
		$this->out(
			f2d_deploy(
				array(
					'page_key'      => $assoc['key'],
					'title'         => $assoc['title'],
					'content'       => $this->read_file( $assoc['content-file'] ),
					'css'           => $this->read_file( $assoc['css-file'] ),
					'build_id'      => $assoc['build-id'],
					'slug'          => $assoc['slug'] ?? null,
					'status'        => $assoc['status'] ?? 'draft',
					'allow_publish' => isset( $assoc['allow-publish'] ),
					'fonts'         => isset( $assoc['fonts-file'] ) ? json_decode( $this->read_file( $assoc['fonts-file'] ), true ) : array(),
				)
			)
		);
	}

	/**
	 * ## OPTIONS
	 * [--key=<page_key>]
	 * [--id=<post_id>]
	 * [--content-out=<path>]
	 */
	public function readback( $args, $assoc ) {
		$id = isset( $assoc['id'] ) ? (int) $assoc['id'] : f2d_find_page( $assoc['key'] ?? '' );
		if ( is_wp_error( $id ) || ! $id ) {
			$this->out( is_wp_error( $id ) ? $id : new WP_Error( 'f2d_not_found', 'No generated page for that key.' ) );
			return;
		}
		$r = f2d_readback( $id );
		if ( ! empty( $assoc['content-out'] ) ) {
			file_put_contents( $assoc['content-out'], $r['content'] );
			unset( $r['content'] );
		}
		$this->out( $r );
	}

	/**
	 * ## OPTIONS
	 * --id=<post_id>
	 * [--build-id=<id>]
	 */
	public function rollback( $args, $assoc ) {
		$this->out( f2d_rollback( (int) $assoc['id'], $assoc['build-id'] ?? null ) );
	}

	/**
	 * ## OPTIONS
	 * --id=<post_id>
	 *
	 * @subcommand clear-cache
	 */
	public function clear_cache( $args, $assoc ) {
		$this->out( f2d_clear_divi_cache( (int) $assoc['id'] ) );
	}

	/**
	 * Import files listed in a JSON manifest [{key,file,hash,name?,title?}] into the media library.
	 *
	 * ## OPTIONS
	 * --manifest=<path>
	 */
	public function media( $args, $assoc ) {
		$items = json_decode( $this->read_file( $assoc['manifest'] ), true );
		$this->out( f2d_import_media( is_array( $items ) ? $items : array() ) );
	}

	/**
	 * ## OPTIONS
	 * --colors=<path>
	 *
	 * @subcommand global-colors
	 */
	public function global_colors( $args, $assoc ) {
		$this->out( f2d_set_global_colors( json_decode( $this->read_file( $assoc['colors'] ), true ) ?: array() ) );
	}

	/**
	 * ## OPTIONS
	 * --id=<post_id>
	 *
	 * @subcommand preview-url
	 */
	public function preview_url( $args, $assoc ) {
		$id = (int) $assoc['id'];
		if ( ! f2d_preview_allowed() || ! f2d_is_generated( $id ) ) {
			$this->out( new WP_Error( 'f2d_no_preview', 'Preview links are only available for generated pages on local/development/staging.' ) );
			return;
		}
		$this->out( array( 'url' => add_query_arg( array( 'page_id' => $id, 'f2d_preview' => f2d_preview_token( $id ) ), home_url( '/' ) ) ) );
	}

	/**
	 * Short-lived login cookies for opening a generated page in the Divi Visual Builder, so QA can
	 * check that the editor shows the page as the front end does. Local/development/staging only.
	 *
	 * ## OPTIONS
	 * --id=<post_id>
	 * [--ttl=<seconds>]
	 *
	 * @subcommand editor-session
	 */
	public function editor_session( $args, $assoc ) {
		$id = (int) $assoc['id'];
		if ( ! f2d_preview_allowed() || ! f2d_is_generated( $id ) ) {
			$this->out( new WP_Error( 'f2d_no_editor_session', 'Editor sessions are only available for generated pages on local/development/staging.' ) );
			return;
		}
		$user = f2d_admin_user();
		if ( ! $user ) {
			$this->out( new WP_Error( 'f2d_no_admin', 'No administrator account to open the builder with.' ) );
			return;
		}
		$expires = time() + max( 60, min( 3600, (int) ( $assoc['ttl'] ?? 900 ) ) );
		$secure  = 'https' === wp_parse_url( home_url(), PHP_URL_SCHEME );
		$auth    = $secure ? SECURE_AUTH_COOKIE : AUTH_COOKIE;
		$value   = wp_generate_auth_cookie( $user, $expires, $secure ? 'secure_auth' : 'auth' );
		$this->out(
			array(
				'domain'  => wp_parse_url( home_url(), PHP_URL_HOST ),
				'secure'  => $secure,
				'expires' => $expires,
				'cookies' => array(
					array( 'name' => $auth, 'value' => $value, 'path' => ADMIN_COOKIE_PATH ),
					array( 'name' => $auth, 'value' => $value, 'path' => PLUGINS_COOKIE_PATH ),
					array( 'name' => LOGGED_IN_COOKIE, 'value' => wp_generate_auth_cookie( $user, $expires, 'logged_in' ), 'path' => COOKIEPATH ),
				),
				'url'     => add_query_arg( array( 'page_id' => $id, 'et_fb' => '1', 'PageSpeed' => 'off' ), home_url( '/' ) ),
			)
		);
	}
}

WP_CLI::add_command( 'f2d', 'F2D_CLI' );
