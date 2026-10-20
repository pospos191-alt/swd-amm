import { fmtSupply, list } from './fmt.js';

// Indonesian. Same keys as en.js (test/i18n.test.js checks it).
export const NAME = 'Bahasa Indonesia';

export const LEVEL = { high: 'Risiko tinggi', medium: 'Risiko sedang', low: 'Risiko rendah', info: 'Tidak ada risiko yang ditemukan oleh aturan ini' };

export const UI = {
  subtitle: 'Membaca dan menjelaskan kontrak · tingkat 1, hanya baca', chain: 'Jaringan', address: 'Alamat kontrak atau token', check: 'Periksa kontrak',
  details: 'Detail', reading: 'Membaca data dari jaringan…', badAddress: 'Alamat tidak valid untuk jaringan ini. Format yang diterima: ',
  failed: 'Gagal membaca: ', footer: 'Tidak pernah meminta Anda menghubungkan dompet dan tidak pernah mengirim transaksi. Hanya membaca data publik dari jaringan. Bukan saran investasi.', stats: 'Statistik penggunaan', language: 'Bahasa',
  m: {
    chain: 'Jaringan', address: 'Alamat', proxy: 'Proxy', implementation: 'Kode utama (implementation)', owner: 'Pemilik', functions: 'Fungsi yang dikenali', report: 'ID laporan', explorer: 'Buka di explorer', fingerprint: 'Sidik jari kode (untuk pendaftaran templat)', unknown: 'Fungsi tanpa nama',
    program: 'Program token', mintAuth: 'Hak mencetak (mint authority)', freezeAuth: 'Hak membekukan (freeze authority)', extensions: 'Ekstensi', upgradeAuth: 'Hak upgrade (upgrade authority)', none: 'tidak ada',
    package: 'Paket', standard: 'Standar', admin: 'Admin', holders: 'Pemegang', listed: 'Daftar tonapi', raw: 'Alamat mentah (raw)',
    idl: 'Anchor IDL', codeId: 'Code ID', label: 'Label', creator: 'Pembuat', migrations: 'Kode pernah diganti', hook: 'Kontrak transfer hook', source: 'Kode sumber terverifikasi', format: 'Format kode', delegation: 'Kode yang dijalankan dompet ini', walletCode: 'Kode dompet pemegang',
  },
};

export const T = {
    'no-code': () => 'Alamat ini tidak memiliki kode kontrak. Mungkin ini dompet biasa, atau jaringan yang dipilih salah.',
    'erc20': (p) => `Token ERC-20 "${p.name ?? '?'}" (${p.symbol ?? '?'}), total pasokan ${fmtSupply(p.totalSupply, p.decimals)}.`,
    'not-erc20': () => 'Tidak ditemukan fungsi standar ERC-20. Kontrak ini mungkin bukan token.',
    'name-has-link': () => 'Nama atau simbol token berisi tautan atau nama situs web. Ini penipuan yang umum (token "airdrop" gratis yang memancing Anda ke situs palsu). Jangan buka situs itu dan jangan hubungkan dompet Anda.',
    'proxy-minimal': (p) => `Klon minimal (EIP-1167) yang selalu menjalankan kode di ${p.implementation}. Kodenya tidak bisa diubah.`,
    'proxy-upgradeable': (p) => (p.issuer
      ? `${p.issuer} dapat meng-upgrade kode kontrak. Ini cara biasa penerbit memperbaiki atau menambah fitur.`
      : `Bisa di-upgrade: admin${p.admin ? ` (${p.admin})` : ''} dapat mengganti seluruh kode kapan saja. Hasil pemeriksaan hari ini belum tentu berlaku besok.`),
    'owner-active': (p) => `Kontrak ini dikendalikan oleh seorang pemilik (owner): ${p.owner}`,
    'owner-renounced': () => 'Kepemilikan sudah dilepas (owner adalah alamat nol). Fungsi khusus pemilik tidak bisa dipanggil lagi.',
    'owner-unknown': () => 'Fungsi owner() tidak ditemukan, jadi tidak jelas siapa yang memegang kekuasaan khusus di bawah ini. Anggap saja ada yang memegangnya.',
    'roles': () => 'Menggunakan izin berbasis peran. Beberapa alamat mungkin memegang kekuasaan khusus; kode saja tidak menunjukkan siapa.',
    'can-mint': (p) => (p.issuer
      ? `${p.issuer} dapat mencetak token (${list(p.functions)}) untuk diterbitkan sesuai dana yang disetor, hal yang wajar untuk jenis token ini.`
      : `Dapat membuat token baru (${list(p.functions)}), sehingga nilai milik pemegang menyusut atau pasar dibanjiri token.`),
    'can-blacklist': (p) => (p.issuer
      ? `${p.issuer} dapat membekukan dompet tertentu (${list(p.functions)}), biasanya untuk dana curian atau perintah hukum.`
      : `Dapat memblokir dompet tertentu (${list(p.functions)}). Dompet yang diblokir mungkin tidak bisa menjual atau mentransfer.`),
    'can-pause': (p) => (p.issuer
      ? `${p.issuer} dapat menghentikan sementara semua transfer (${list(p.functions)}) dalam keadaan darurat.`
      : `Dapat membekukan semua transfer (${list(p.functions)}). Bisa jadi tidak ada yang bisa menjual.`),
    'can-change-fee': (p) => (p.decreaseOnly
      ? `Dapat mengubah pajak (${list(p.functions)}), tetapi templat ${p.project} hanya mengizinkan pajak diturunkan.`
      : `Dapat mengubah pajak beli/jual (${list(p.functions)}). Pajak jual yang sangat tinggi berarti hasil penjualan hampir nol.`),
    'known-issuer': (p) => `Kontrak resmi ${p.symbol} yang diterbitkan oleh ${p.issuer} (cocok dengan alamat yang terdaftar). Kekuasaan di bawah ini milik penerbit; risiko utamanya adalah kepercayaan pada penerbit, bukan kode tersembunyi.`,
    'lookalike': (p) => `Memakai simbol ${p.symbol} seperti token milik ${p.issuer}, tetapi BUKAN alamat resmi (${p.official}). Kemungkinan palsu; jangan beli atau terima sebelum Anda memeriksa alamatnya.`,
    'template-match': (p) => `Cocok dengan templat token ${p.project} yang terdaftar (${p.name}). Aturan templat ini belum diaudit.`,
    'template-mismatch': (p) => `Kode cocok dengan templat ${p.project}, tetapi memiliki kekuasaan yang menurut templat tidak ada (${list(p.functions)}). Catatan templat mungkin salah; jangan dipercaya sebelum diperiksa.`,
    'trading-switch': (p) => `Memiliki tombol buka/tutup perdagangan (${list(p.functions)}). Sebelum dibuka, Anda mungkin bisa membeli tetapi tidak bisa menjual.`,
    'can-limit': (p) => `Dapat mengatur batas per transaksi atau per dompet (${list(p.functions)}). Batas yang sangat rendah bisa menghalangi penjualan.`,
    'fee-exempt': (p) => `Dapat membebaskan dompet tertentu dari pajak (${list(p.functions)}). Umum pada token berpajak, tetapi memberi keuntungan bagi dompet tertentu.`,
    'network-flagged': (p) => `Jaringan Neuro ZETAPHY memilih kode ini sebagai berbahaya${p.reason ? ` (${p.reason})` : ''}. Setiap kontrak dengan kode yang sama mendapat peringatan yang sama.`,
    'tax-wallet': (p) => `Dapat mengganti dompet penerima pajak (${list(p.functions)}). Umum pada token berpajak.`,
    'selfdestruct': () => 'Kode berisi SELFDESTRUCT. Jika dipicu, kontrak bisa dihapus atau dananya dipindahkan.',
    'delegatecall': () => 'Kode dapat menjalankan kode kontrak lain seolah-olah miliknya sendiri (DELEGATECALL), jadi kode yang benar-benar berjalan mungkin bukan kode yang ditampilkan di sini.',
    'nothing-found': () => 'Aturan ini tidak menemukan kekuasaan khusus atau instruksi berbahaya.',
    'unknown-functions': (p) => `Ada ${p.count} fungsi lain yang tidak bisa dikenali Neuro (${(p.selectors ?? []).map((x) => '0x' + x).join(', ')}), jadi fungsinya tidak diketahui. Selama masih ada pemilik yang mengendalikan kontrak, fungsi ini mungkin fungsi khusus, misalnya untuk mengatur pajak atau batas perdagangan.`,
    'bytecode-only': () => 'Diperiksa dari kode on-chain dengan aturan tetap. Penipuan yang bersembunyi di balik nama fungsi yang tidak biasa bisa terlewat. Bukan saran investasi.',
    // Solana
    'sol-not-found': () => 'Tidak ada akun di alamat ini di Solana. Mungkin salah ketik, atau jaringan yang dipilih salah.',
    'sol-not-token': (p) => `Alamat ini bukan token mint di Solana; ini adalah akun milik program ${p.owner}.`,
    'sol-token': (p) => `Token ${p.program} "${p.name ?? '?'}" (${p.symbol ?? '?'}), total pasokan ${fmtSupply(p.totalSupply, p.decimals)}.`,
    'sol-mint-authority': (p) => (p.issuer
      ? `${p.issuer} dapat mencetak token (mint authority: ${p.authority}) untuk diterbitkan sesuai dana yang disetor, hal yang wajar untuk jenis token ini.`
      : `Token baru masih bisa dicetak (mint authority: ${p.authority}), sehingga nilai milik pemegang menyusut atau pasar dibanjiri token.`),
    'sol-mint-renounced': () => 'Hak mencetak (mint authority) sudah dilepas: jumlah pasokan tidak akan pernah bertambah.',
    'sol-freeze-authority': (p) => (p.issuer
      ? `${p.issuer} dapat membekukan akun (freeze authority), biasanya untuk dana curian atau perintah hukum.`
      : `Akun masih bisa dibekukan (freeze authority: ${p.authority}). Akun yang dibekukan tidak bisa menjual atau mentransfer, penipuan yang umum di Solana.`),
    'sol-freeze-renounced': () => 'Hak membekukan (freeze authority) sudah dilepas: tidak ada yang bisa membekukan token Anda.',
    'sol-permanent-delegate': (p) => (p.issuer
      ? `${p.issuer} dapat memindahkan atau membakar token dari akun mana pun (permanent delegate), digunakan untuk penyitaan hukum.`
      : `Seorang wakil permanen (permanent delegate: ${p.delegate}) dapat memindahkan atau membakar token dari SEMUA dompet tanpa izin. Sangat berbahaya.`),
    'sol-transfer-fee': (p) => `Memungut biaya ${p.percent}% untuk setiap transfer${p.authority ? `, dan pemegang hak biaya (${p.authority}) dapat menaikkannya hingga 100%` : ''}.`,
    'sol-transfer-hook': (p) => `Setiap transfer menjalankan program tambahan (transfer hook: ${p.programId}) yang dapat menerapkan aturannya sendiri, misalnya memblokir penjualan.`,
    'sol-default-frozen': () => 'Akun baru untuk token ini langsung dalam keadaan beku: setelah membeli, Anda mungkin tidak bisa memindahkan atau menjual sampai dibuka.',
    'sol-pausable': (p) => `Semua transfer dapat dihentikan sementara (pausable)${p.paused ? ', dan saat ini memang sedang dihentikan' : ''}.`,
    'sol-close-authority': (p) => `Mint dapat ditutup lalu dibuat ulang di alamat yang sama (close authority: ${p.authority}).`,
    'sol-non-transferable': () => 'Token ini tidak bisa ditransfer (non-transferable): ini lencana atau hak, bukan koin yang bisa diperdagangkan.',
    'sol-metadata-mutable': (p) => `Nama, simbol, dan gambar masih bisa diubah (update authority: ${p.authority}), misalnya nanti dibuat meniru token lain.`,
    'sol-program-upgradeable': (p) => `Program bisa di-upgrade: pemegang hak (${p.authority}) dapat mengganti kodenya kapan saja.`,
    'sol-program-immutable': () => 'Program ini tidak bisa di-upgrade lagi; kodenya sudah tetap.',
    'sol-caveat': () => 'Diperiksa dari data akun on-chain dengan aturan tetap; likuiditas dan sebaran pemegang tidak diperiksa. Bukan saran investasi.',
    'can-seize': (p) => (p.issuer
      ? `${p.issuer} dapat menyita atau membakar token dari dompet mana pun (${list(p.functions)}), digunakan untuk penyitaan hukum.`
      : `Memiliki fungsi yang dapat mengambil atau membakar token dari dompet orang lain (${list(p.functions)}). Token Anda bisa diambil tanpa izin Anda.`),
    // Sui
    'sui-not-found': () => 'Tidak ada koin atau paket di alamat ini di Sui. Mungkin salah ketik, atau jaringan yang dipilih salah.',
    'sui-coin': (p) => `Koin Sui "${p.name ?? '?'}" (${p.symbol ?? '?'}), total pasokan ${fmtSupply(p.totalSupply, p.decimals)}.`,
    'sui-not-coin': (p) => `Paket ${p.package} ada, tetapi tidak ditemukan koin dengan nama itu. Periksa nama modul dan nama koinnya.`,
    'sui-package': (p) => `Paket kode Move di Sui (${p.package}), bukan koin. Hasil di bawah ini adalah kekuasaan yang dibuka oleh kodenya.`,
    'sui-supply-fixed': () => 'Jumlah pasokan dikunci: tidak akan pernah bertambah atau berkurang.',
    'sui-supply-burn-only': () => 'Tidak ada koin baru yang bisa dicetak; koin hanya bisa dibakar.',
    'sui-treasury': (p) => {
      if (p.issuer) return `${p.issuer} dapat mencetak koin (TreasuryCap) untuk diterbitkan sesuai dana yang disetor, hal yang wajar untuk jenis koin ini.`;
      if (p.holder) return `Koin baru masih bisa dicetak: dompet ${p.holder} memegang kunci pencetakan (TreasuryCap) dan dapat mencetak tanpa batas, sehingga nilai milik pemegang menyusut atau pasar dibanjiri koin.`;
      const where = { object: 'disimpan di dalam kontrak lain', shared: 'berada di objek bersama (shared object)' }[p.where] ?? 'masih ada, tetapi pemegangnya tidak ditemukan';
      return `Koin baru masih bisa dicetak: kunci pencetakan (TreasuryCap) ${where}. Aturan pencetakan bergantung pada kode yang memegangnya.`;
    },
    'sui-regulated': (p) => (p.issuer
      ? `${p.issuer} dapat memblokir dompet tertentu (DenyCap), biasanya untuk dana curian atau perintah hukum.`
      : `Koin yang diatur (regulated): pemegang DenyCap${p.holder ? ` (${p.holder})` : ''} dapat memblokir dompet. Dompet yang diblokir tidak bisa memakai atau menjual koin ini.`),
    'sui-global-pause': (p) => (p.issuer
      ? `${p.issuer} dapat menghentikan sementara semua penggunaan koin ini dalam keadaan darurat.`
      : 'Pemegang DenyCap dapat menghentikan koin ini untuk semua orang sekaligus (global pause).'),
    'sui-system': () => 'Kode sistem Sui: hanya bisa di-upgrade melalui pemungutan suara validator.',
    'sui-upgradeable': (p) => (p.issuer
      ? `${p.issuer} dapat meng-upgrade kode paket. Ini cara biasa penerbit memperbaiki atau menambah fitur.`
      : `Paket bisa di-upgrade: pemegang UpgradeCap${p.holder ? ` (${p.holder})` : p.where === 'object' ? ' (disimpan di dalam kontrak lain)' : ''} dapat mengubah kode (kebijakan: ${p.policy}). Hasil pemeriksaan hari ini belum tentu berlaku besok.`),
    'sui-upgrade-cap-gone': () => 'Kunci upgrade (UpgradeCap) tidak lagi berdiri sendiri: kunci itu sudah dihancurkan sehingga kodenya permanen, atau dikunci di dalam kontrak lain.',
    'move-truncated': () => 'Paket ini besar; Neuro hanya memeriksa 50 modul pertama dan 50 fungsi per modul.',
    'move-caveat': () => 'Diperiksa dari nama fungsi dan data on-chain dengan aturan tetap. Isi fungsi dan likuiditas tidak diperiksa. Bukan saran investasi.',
    // Aptos
    'apt-not-found': () => 'Tidak ada koin atau akun di alamat ini di Aptos. Mungkin salah ketik, atau jaringan yang dipilih salah.',
    'apt-not-token': (p) => (p.account ? 'Alamat ini adalah akun pengguna di Aptos, bukan token.' : 'Alamat ini adalah objek Aptos yang bukan token.'),
    'apt-token': (p) => `${p.standard} Aptos "${p.name ?? '?'}" (${p.symbol ?? '?'}), total pasokan ${fmtSupply(p.totalSupply, p.decimals)}${p.maxSupply ? `, maksimum ${fmtSupply(p.maxSupply, p.decimals)}` : ''}.`,
    'apt-package': (p) => `Paket kode Move di Aptos (${p.address}), bukan token. Hasil di bawah ini adalah kekuasaan yang dibuka oleh kodenya.`,
    'apt-managed-coin': (p) => (p.issuer
      ? `${p.issuer} dapat mencetak, membekukan, dan membakar token (managed_coin), hal yang wajar untuk jenis token ini.`
      : `Pembuat token (${p.account}) memegang hak mencetak, membekukan, dan membakar (managed_coin) dan dapat mencetak kapan saja.`),
    'apt-mint-power': (p) => (p.issuer
      ? `${p.issuer} dapat mencetak token untuk diterbitkan sesuai dana yang disetor, hal yang wajar untuk jenis token ini.`
      : `Kode milik pembuat token menyimpan hak mencetak (${list(p.structs)}). Token baru masih bisa dibuat, sehingga nilai milik pemegang menyusut.`),
    'apt-freeze-power': (p) => (p.issuer
      ? `${p.issuer} dapat membekukan dompet tertentu, biasanya untuk dana curian atau perintah hukum.`
      : `Kode milik pembuat token menyimpan hak membekukan dompet (${list(p.structs)}). Dompet yang dibekukan tidak bisa menjual atau mentransfer, dan TransferRef dapat memindahkan token Anda tanpa izin.`),
    'apt-burn-power': (p) => (p.issuer
      ? `${p.issuer} dapat membakar token dari dompet mana pun, digunakan untuk penyitaan hukum.`
      : `Kode milik pembuat token menyimpan hak membakar (${list(p.structs)}) token dari dompet siapa pun.`),
    'apt-dispatch': (p) => (p.issuer
      ? `${p.issuer} menjalankan kode tambahan pada setiap setoran dan penarikan (${list(p.functions)}).`
      : `Setiap setoran dan penarikan menjalankan kode tambahan (${list(p.functions)}) yang dapat menerapkan aturannya sendiri, misalnya memblokir penjualan.`),
    'apt-untransferable': () => 'Tempat penyimpanan token tidak bisa berganti pemilik (untransferable). Transfer token biasa tetap berfungsi.',
    'apt-upgradeable': (p) => (p.issuer
      ? `${p.issuer} dapat meng-upgrade kode. Ini cara biasa penerbit memperbaiki atau menambah fitur.`
      : `Kode milik pembuat token (${list(p.packages)} di ${p.address}) bisa di-upgrade: akun tersebut dapat mengubahnya kapan saja. Hasil pemeriksaan hari ini belum tentu berlaku besok.`),
    'apt-immutable': (p) => `Kode milik pembuat token (${p.address}) disetel tidak dapat diubah (immutable): kodenya tidak akan pernah berubah.`,
    'apt-framework': () => 'Kode sistem Aptos: hanya bisa di-upgrade melalui pemungutan suara jaringan.',
    // TON
    'ton-not-found': () => 'Tidak ada kontrak di alamat ini di TON (tidak ada atau belum di-deploy). Mungkin salah ketik.',
    'ton-not-jetton': (p) => {
      if (p.wallet) return 'Alamat ini adalah dompet, bukan token.';
      if ((p.interfaces ?? []).includes('jetton_wallet')) return 'Ini adalah jetton wallet milik satu pemegang, bukan token itu sendiri. Masukkan alamat utama token (jetton master).';
      return `Kontrak TON ini bukan token${p.interfaces?.length ? ` (${list(p.interfaces)})` : ''}.`;
    },
    'ton-scam': () => 'tonapi.io menandai token ini atau admin-nya terkait dengan penipuan. Jangan beli atau terima token ini.',
    'ton-jetton': (p) => `Token TON (jetton) "${p.name ?? '?'}" (${p.symbol ?? '?'}), total pasokan ${fmtSupply(p.totalSupply, p.decimals)}${p.holders != null ? `, ${fmtSupply(p.holders, 0)} pemegang` : ''}.`,
    'ton-listed': () => 'Ada di daftar token terperiksa milik tonapi.io (whitelist). Itu daftar dari pihak ketiga, bukan jaminan.',
    'ton-frozen': () => 'Kontrak token ini dibekukan karena biaya penyimpanan belum dibayar dan saat ini tidak bisa digunakan.',
    'ton-mintable': (p) => (p.issuer
      ? `${p.issuer} dapat mencetak token untuk diterbitkan sesuai dana yang disetor, hal yang wajar untuk jenis token ini.`
      : `Admin (${p.admin}) masih dapat mencetak token baru, sehingga nilai milik pemegang menyusut atau pasar dibanjiri token.`),
    'ton-admin': (p) => (p.issuer
      ? `${p.issuer} adalah admin kontrak dan dapat mengubah data token.`
      : `Seorang admin (${p.admin}) masih dapat mengubah nama dan logo, dan jika kode kontraknya tidak standar, mungkin memegang kekuasaan lain yang tidak terlihat oleh pemeriksaan ini.`),
    'ton-admin-dropped': () => 'Peran admin sudah dilepas: tidak ada lagi yang bisa mencetak token atau mengubah data token.',
    'ton-mint-flag': () => 'Kontrak masih menyatakan token bisa dicetak, tetapi tidak ada admin yang bisa mencetaknya.',
    'ton-caveat': () => 'Diperiksa dari data kontrak yang diurai oleh tonapi.io dengan aturan tetap; dompet pemegang diperiksa berdasarkan apa yang dikenali tonapi, bukan dibaca baris demi baris. Bukan saran investasi.',
    'ton-wallet-standard': (p) => `Token milik pemegang tersimpan di dompet jetton standar yang dikenali tonapi.io (${list(p.interfaces)}).`,
    'ton-wallet-custom': (p) => (p.issuer
      ? `${p.issuer} memakai kode dompet jetton sendiri, hal yang wajar untuk token ini.`
      : `Token milik pemegang tersimpan di kode dompet yang tidak dikenali tonapi.io sebagai dompet jetton standar${p.compiler ? ` (${p.compiler})` : ''}. Kode dompet khusus bisa menolak pengiriman, sehingga Anda mungkin bisa membeli tetapi tidak bisa menjual. Hash kode: ${p.codeHash ?? '?'}.`),
    // Solana programs (Anchor IDL)
    'sol-idl': (p) => `Program ini ditulis dengan Rust (Anchor) dan menerbitkan daftar instruksinya di on-chain: ${p.name ?? '?'}, ${p.count ?? '?'} instruksi.`,
    'sol-admin-instructions': (p) => `Instruksi yang memerlukan tanda tangan admin (${list(p.functions)}). Admin dapat memakainya untuk mengubah cara kerja program.`,
    'sol-no-idl': () => 'Program ini tidak menerbitkan daftar instruksinya (Anchor IDL) di on-chain, sehingga apa yang bisa dilakukannya tidak dapat dibaca.',
    // EVM code that is not EVM bytecode
    'stylus-code': (p) => (p.issuer
      ? `${p.issuer} memakai kontrak Stylus (Rust/C++ yang dikompilasi menjadi WASM di Arbitrum), yang belum bisa dibaca oleh aturan Neuro.`
      : 'Kontrak Stylus (Rust atau C++ yang dikompilasi menjadi WASM di Arbitrum). Aturan Neuro belum bisa membaca kode ini, jadi tidak diketahui apakah kontrak ini dapat mencetak token, memblokir dompet, atau menghentikan transfer. Anggap saja belum diperiksa.'),
    'unknown-code-format': (p) => (p.issuer
      ? `${p.issuer} memakai kode yang bukan EVM bytecode standar.`
      : 'Kode kontrak ini bukan EVM bytecode standar dan tidak bisa dibaca oleh aturan Neuro. Anggap saja belum diperiksa.'),
    'eip7702': (p) => `Alamat ini adalah dompet biasa yang pemiliknya mengaturnya untuk menjalankan kode kontrak ${p.target} (EIP-7702). Ini bukan token. Kode itu dapat melakukan apa saja yang tertulis di dalamnya terhadap dana di dompet ini; periksa juga ${p.target}.`,
    'source-verified': (p) => `Ada kode sumber publik yang sudah dikonfirmasi Sourcify ${p.match === 'exact' ? 'sama persis byte demi byte dengan kode on-chain' : 'sesuai dengan kode on-chain'} (${[p.name, p.language, p.compiler].filter(Boolean).join(', ')}). Baca di ${p.url}`,
    'source-unverified': () => 'Tidak ada kode sumber di Sourcify. Kode sumbernya mungkin tetap dipublikasikan di explorer jaringan ini; jika tidak dipublikasikan di mana pun, berhati-hatilah.',
    // CosmWasm (Osmosis, Neutron)
    'cw-not-found': () => 'Tidak ada kontrak atau token di alamat ini di jaringan ini. Mungkin salah ketik, atau jaringan yang dipilih salah.',
    'cw20-token': (p) => `Token CW20 (kontrak Rust di CosmWasm) "${p.name ?? '?'}" (${p.symbol ?? '?'}), total pasokan ${fmtSupply(p.totalSupply, p.decimals)}.`,
    'cw-contract': (p) => `Kontrak CosmWasm (ditulis dengan Rust)${p.label ? ` bernama "${p.label}"` : ''}, code ID ${p.codeId ?? '?'}. Bukan token CW20.`,
    'cw-admin': (p) => `Admin (${p.admin}) dapat mengganti kode kontrak dengan kode baru kapan saja (migrate). Hasil pemeriksaan hari ini belum tentu berlaku besok.`,
    'cw-no-admin': () => 'Tidak ada admin: kode kontrak tidak akan pernah bisa diganti.',
    'cw-migrated': (p) => `Kode kontrak ini sudah pernah diganti ${p.count} kali.`,
    'cw20-minter': (p) => `${p.minter} masih dapat mencetak token baru${p.cap ? `, hingga total ${fmtSupply(p.cap, p.decimals)}` : ' tanpa batas'}, sehingga nilai milik pemegang menyusut atau pasar dibanjiri token.`,
    'cw20-no-minter': () => 'Tidak ada yang bisa mencetak token ini lagi.',
    'tf-token': (p) => `Koin Token Factory "${p.name ?? '?'}"${p.symbol ? ` (${p.symbol})` : ''} yang dibuat oleh ${p.creator}, total pasokan ${fmtSupply(p.totalSupply, p.decimals)}.`,
    'tf-admin': (p) => `Admin (${p.admin}) dapat mencetak tanpa batas, dan di beberapa jaringan juga dapat memindahkan atau membakar token dari dompet orang lain.`,
    'tf-no-admin': () => 'Peran admin sudah dilepas: tidak ada lagi yang bisa mencetak.',
    'tf-hook': (p) => `Setiap transfer harus melewati kontrak ${p.contract} (before-send hook), yang dapat menerapkan aturannya sendiri, misalnya memblokir penjualan.`,
    'cw-caveat': () => 'Diperiksa dari data kontrak on-chain dengan aturan tetap. Kode Rust di dalamnya dan likuiditas tidak diperiksa. Bukan saran investasi.',
};
