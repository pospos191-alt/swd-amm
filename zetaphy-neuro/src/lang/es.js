import { fmtSupply, list } from './fmt.js';

// Spanish (Español). Same keys as en.js; code names, brands and token names stay as they are.
export const NAME = 'Español';

export const LEVEL = { high: 'Riesgo alto', medium: 'Riesgo medio', low: 'Riesgo bajo', info: 'Estas reglas no encontraron riesgos' };

export const UI = {
  subtitle: 'Lee y explica contratos · nivel 1, solo lectura', chain: 'Red', address: 'Dirección del contrato o token', check: 'Revisar contrato',
  details: 'Detalles', reading: 'Leyendo de la blockchain…', badAddress: 'Dirección no válida para esta red. Formatos aceptados: ',
  failed: 'No se pudo leer: ', footer: 'Nunca pide conectar una wallet y nunca envía transacciones. Lee datos públicos de la blockchain; para la alerta temprana solo envía la red y la dirección del contrato al servidor de este sitio, que no guarda nada. No es asesoramiento de inversión.', stats: 'Estadísticas de uso', language: 'Idioma',
  disclaimer: 'Esto es un análisis de código automático y reproducible, no una acusación contra ninguna persona o proyecto, y no es asesoramiento de inversión. El dueño del contrato puede responder o pedir una corrección.',
  correction: 'Cómo responder o pedir una corrección',
  reproduce: 'Compruébalo tú mismo',
  reproduceHow: 'Cualquiera puede repetir esta revisión con el comando de abajo (en la carpeta zetaphy-neuro). El ID de veredicto cubre solo lo que decidieron las reglas, así que coincide mientras el código y la configuración del contrato no cambien. El ID de informe también cubre cifras que cambian, como el suministro.',
  asWritten: 'El nombre y el símbolo se muestran tal como están escritos en el contrato; Neuro no los confirma.',
  early: 'Alerta temprana: patrones aún no publicados',
  earlyHow: 'El servidor de ZETAPHY también compara el código de este contrato con patrones que se están vigilando pero aún no son públicos, para que no se puedan esquivar antes de anunciarse. Coincidió con los patrones de abajo. Es solo orientativo: no forma parte del resultado de arriba ni del veredicto de la red, puede equivocarse, y los patrones se publican más adelante (normalmente en unos 30 días).',
  m: {
    chain: 'Red', address: 'Dirección', proxy: 'Proxy', implementation: 'Implementación', owner: 'Owner (propietario)', functions: 'Funciones conocidas', report: 'ID de informe', explorer: 'Abrir en el explorador', fingerprint: 'Huella del código (para registrar plantillas)', unknown: 'Funciones sin nombre',
    program: 'Programa del token', mintAuth: 'Autoridad de mint', freezeAuth: 'Autoridad de congelación', extensions: 'Extensiones', upgradeAuth: 'Autoridad de actualización', none: 'ninguna',
    package: 'Paquete', standard: 'Estándar', admin: 'Admin', holders: 'Holders', listed: 'Lista de tonapi', raw: 'Dirección en bruto',
    idl: 'Anchor IDL', codeId: 'Code ID', label: 'Etiqueta', creator: 'Creador', migrations: 'Código reemplazado', hook: 'Contrato de transfer hook', source: 'Código fuente verificado', format: 'Formato del código', delegation: 'Código que ejecuta esta wallet', walletCode: 'Código de la wallet de los holders', nearKeys: 'Claves de acceso total', codeHash: 'Hash del código', cairo: 'Versión de Cairo', maxSupply: 'Suministro máximo', tokenId: 'ID del token',
    pool: 'Pool de liquidez', simTax: 'Impuesto simulado (compra / venta)', simFailed: 'la venta falló',
    verdict: 'ID de veredicto (solo reglas)', command: 'Comando', rule: 'regla',
    earlyMatch: 'Coincide con un patrón vigilado. Categoría:', earlyRef: 'referencia',
  },
};

// ThreatRegistry categories (src/threat-reasons.js), as neutral descriptions of what the code does.
export const REASON = { 'cannot-sell-in-simulation': 'en una operación simulada, la venta falló o devolvió casi nada', 'unlimited-mint': 'una dirección puede crear (mint) tokens nuevos sin límite', 'owner-can-block-transfers': 'un owner o admin puede detener transferencias o ventas', 'owner-can-move-holder-funds': 'un owner o admin puede mover o quemar fondos de otras personas', 'same-name-as-known-token': 'mismo nombre o símbolo que un token conocido, en otra dirección', 'sweeps-approved-tokens': 'en una prueba reproducible, movió tokens aprobados a una dirección que el holder no eligió', 'other': 'otro hecho del código (ver la evidencia)' };

export const T = {
    'no-code': () => 'Esta dirección no tiene código de contrato. Puede ser una wallet normal, o hay otra red seleccionada.',
    'erc20': (p) => `Token ERC-20 "${p.name ?? '?'}" (${p.symbol ?? '?'}), suministro total ${fmtSupply(p.totalSupply, p.decimals)}.`,
    'not-erc20': () => 'No se encontraron funciones estándar de ERC-20. Puede que este contrato no sea un token.',
    'name-has-link': () => 'El nombre o símbolo del token, tal como está escrito en el contrato, contiene un enlace o el nombre de un sitio web. Los tokens enviados sin pedirlos con un enlace en el nombre se usan a menudo para llevar a la gente a sitios externos. No visites el sitio ni conectes tu wallet por el nombre del token.',
    'proxy-minimal': (p) => `Clon mínimo (EIP-1167) que siempre ejecuta el código en ${p.implementation}. El código no se puede cambiar.`,
    'proxy-upgradeable': (p) => (p.issuer
      ? `${p.issuer} puede actualizar el código del contrato, la forma habitual en que los emisores lo corrigen o amplían.`
      : `Actualizable (proxy): el admin${p.admin ? ` (${p.admin})` : ''} puede reemplazar todo el código en cualquier momento. Lo que se revisa hoy puede no valer mañana.`),
    'owner-active': (p) => `Un owner (propietario) controla este contrato: ${p.owner}`,
    'owner-renounced': () => 'La propiedad está renunciada (el owner es la dirección cero). Las funciones solo para el owner ya no se pueden llamar.',
    'owner-unknown': () => 'No se encontró la función owner(), así que no está claro quién tiene los poderes especiales de abajo. Asume que alguien los tiene.',
    'roles': () => 'Usa permisos por roles. Varias direcciones pueden tener poderes especiales; el código por sí solo no muestra quiénes.',
    'can-mint': (p) => (p.issuer
      ? `${p.issuer} puede hacer mint (${list(p.functions)}) para emitir tokens respaldados por depósitos, como es normal en este tipo de token.`
      : `Puede hacer mint de tokens nuevos (${list(p.functions)}), diluyendo a los holders o inundando el mercado.`),
    'can-blacklist': (p) => (p.issuer
      ? `${p.issuer} puede congelar wallets concretas (${list(p.functions)}), normalmente por fondos robados u órdenes judiciales.`
      : `Puede bloquear wallets concretas (lista negra) (${list(p.functions)}). Una wallet bloqueada puede no poder vender ni transferir.`),
    'can-pause': (p) => (p.issuer
      ? `${p.issuer} puede pausar todas las transferencias (${list(p.functions)}) en una emergencia.`
      : `Puede congelar todas las transferencias (${list(p.functions)}). Puede que nadie consiga vender.`),
    'can-change-fee': (p) => (p.decreaseOnly
      ? `Puede ajustar el impuesto (${list(p.functions)}), pero la plantilla de ${p.project} solo permite bajarlo.`
      : `Puede cambiar el impuesto de compra/venta (${list(p.functions)}). Un impuesto de venta muy alto significa que vender devuelve casi nada.`),
    'known-issuer': (p) => `Contrato oficial de ${p.symbol} emitido por ${p.issuer} (coincide con la dirección registrada). Los poderes de abajo pertenecen al emisor; el riesgo principal es confiar en el emisor, no código oculto.`,
    'lookalike': (p) => `Usa el símbolo ${p.symbol}, el mismo que el token de ${p.issuer}, pero NO es la dirección registrada para él (${p.official}). Este contrato no es el token registrado de ${p.issuer}; revisa la dirección antes de comprarlo o aceptarlo.`,
    'template-match': (p) => `Coincide con la plantilla de token registrada de ${p.project} (${p.name}). Las reglas de la plantilla aún no están auditadas.`,
    'template-mismatch': (p) => `El código coincide con la plantilla de ${p.project}, pero tiene un poder que según la plantilla no tiene (${list(p.functions)}). El registro de la plantilla puede estar mal; no confíes en él hasta que se revise.`,
    'trading-switch': (p) => `Tiene un interruptor para activar/desactivar el trading (${list(p.functions)}). Mientras no esté activado, puede que puedas comprar pero no vender.`,
    'can-limit': (p) => `Puede fijar límites por transacción o por wallet (${list(p.functions)}). Límites muy bajos pueden impedir vender.`,
    'fee-exempt': (p) => `Puede eximir del impuesto a wallets elegidas (${list(p.functions)}). Es común en tokens con impuesto, pero da ventaja a algunas wallets.`,
    'network-flagged': (p) => `Los runners de la red Neuro ZETAPHY votaron registrar este código exacto en el ThreatRegistry${p.reason ? ` (categoría: ${REASON[p.reason] ?? p.reason})` : ''}. Todo contrato con el mismo código recibe la misma advertencia.`,
    'similar-flagged': (p) => `Este código es ${p.percent}% similar a un código que los runners de Neuro marcaron (huella ${String(p.fingerprint ?? '').slice(0, 12)}…${p.reason ? `, categoría: ${REASON[p.reason] ?? p.reason}` : ''}). Las copias ligeramente editadas de código marcado suelen comportarse igual.`,
    'similar-reference': (p) => `Este código es ${p.percent}% similar a una muestra de referencia del conjunto de datos de Neuro (huella ${String(p.fingerprint ?? '').slice(0, 12)}…${p.reason ? `, categoría: ${REASON[p.reason] ?? p.reason}` : ''}). La muestra no es código que los runners de Neuro hayan marcado en la cadena. La similitud es una pista para mirar más de cerca, no una prueba.`,
    'tax-wallet': (p) => `Puede cambiar la wallet que recibe el impuesto (${list(p.functions)}). Es común en tokens con impuesto.`,
    'selfdestruct': () => 'El código contiene SELFDESTRUCT. Si se activa, puede borrar el contrato o mover sus fondos.',
    'delegatecall': () => 'El código puede ejecutar el código de otro contrato como si fuera propio (DELEGATECALL), así que el código que realmente se ejecuta puede no ser el que se muestra aquí.',
    'nothing-found': () => 'Estas reglas no encontraron poderes especiales ni instrucciones peligrosas.',
    'unknown-functions': (p) => `${p.count} función(es) más que Neuro no puede nombrar (${(p.selectors ?? []).map((x) => '0x' + x).join(', ')}), así que no se sabe qué hacen. Mientras un owner siga controlando el contrato, pueden ser privilegiadas, p. ej. para fijar un impuesto o límites de trading.`,
    'unknown-pattern': (p) => `Neuro aún no reconoce este patrón, ten cuidado: el ${p.share}% de sus funciones no tiene un nombre conocido, y el código puede mover monedas o tokens. No encontrar nada aquí no significa que sea seguro.`,
    'bytecode-only': () => 'Revisado a partir del código en la cadena con reglas fijas. Pueden pasarse por alto poderes ocultos tras nombres de función poco comunes. No es asesoramiento de inversión.',
    // Solana
    'sol-not-found': () => 'No hay ninguna cuenta en esta dirección en Solana. Puede estar mal escrita, o hay otra red seleccionada.',
    'sol-not-token': (p) => `Esta dirección no es un token mint en Solana; es una cuenta del programa ${p.owner}.`,
    'sol-token': (p) => `Token ${p.program} "${p.name ?? '?'}" (${p.symbol ?? '?'}), suministro total ${fmtSupply(p.totalSupply, p.decimals)}.`,
    'sol-mint-authority': (p) => (p.issuer
      ? `${p.issuer} puede hacer mint (autoridad de mint: ${p.authority}) para emitir tokens respaldados por depósitos, como es normal en este tipo de token.`
      : `Todavía se pueden crear tokens nuevos (autoridad de mint: ${p.authority}), diluyendo a los holders o inundando el mercado.`),
    'sol-mint-renounced': () => 'La autoridad de mint está renunciada: el suministro nunca puede crecer.',
    'sol-freeze-authority': (p) => (p.issuer
      ? `${p.issuer} puede congelar cuentas (autoridad de congelación), normalmente por fondos robados u órdenes judiciales.`
      : `Las cuentas todavía se pueden congelar (autoridad de congelación: ${p.authority}). Una cuenta congelada no puede vender ni transferir.`),
    'sol-freeze-renounced': () => 'La autoridad de congelación está renunciada: nadie puede congelar tus tokens.',
    'sol-permanent-delegate': (p) => (p.issuer
      ? `${p.issuer} puede mover o quemar tokens de cualquier cuenta (delegado permanente), algo que se usa para incautaciones legales.`
      : `Un delegado permanente (${p.delegate}) puede mover o quemar tokens de TODAS las wallets sin permiso. Riesgo muy alto para los holders.`),
    'sol-transfer-fee': (p) => `Cobra un ${p.percent}% en cada transferencia${p.authority ? `, y la autoridad de comisiones (${p.authority}) puede subirla hasta el 100%` : ''}.`,
    'sol-transfer-hook': (p) => `Cada transferencia ejecuta un programa extra (transfer hook: ${p.programId}) que puede imponer sus propias reglas, como bloquear ventas.`,
    'sol-default-frozen': () => 'Las cuentas nuevas de este token empiezan congeladas: después de comprar puede que no puedas mover ni vender hasta que se descongelen.',
    'sol-pausable': (p) => `Todas las transferencias se pueden pausar (pausable)${p.paused ? ', y ahora mismo están pausadas' : ''}.`,
    'sol-close-authority': (p) => `El mint se puede cerrar y volver a crear en la misma dirección (autoridad de cierre: ${p.authority}).`,
    'sol-non-transferable': () => 'Este token no se puede transferir (non-transferable): es una insignia o un derecho, no una moneda para comerciar.',
    'sol-metadata-mutable': (p) => `El nombre, el símbolo y la imagen todavía se pueden cambiar (autoridad de actualización: ${p.authority}), p. ej. más adelante para imitar otro token.`,
    'sol-program-upgradeable': (p) => `Programa actualizable: la autoridad (${p.authority}) puede reemplazar su código en cualquier momento.`,
    'sol-program-immutable': () => 'Este programa ya no se puede actualizar; su código es fijo.',
    'sol-caveat': () => 'Revisado a partir de los datos de la cuenta en la cadena con reglas fijas; no se revisan la liquidez ni la distribución de holders. No es asesoramiento de inversión.',
    'can-seize': (p) => (p.issuer
      ? `${p.issuer} puede incautar o quemar tokens de cualquier wallet (${list(p.functions)}), algo que se usa para incautaciones legales.`
      : `Tiene funciones que quitan o queman tokens de las wallets de otras personas (${list(p.functions)}). Te podrían quitar tus tokens sin tu permiso.`),
    // Sui
    'sui-not-found': () => 'No hay ninguna moneda ni paquete en esta dirección en Sui. Puede estar mal escrita, o hay otra red seleccionada.',
    'sui-coin': (p) => `Moneda de Sui "${p.name ?? '?'}" (${p.symbol ?? '?'}), suministro total ${fmtSupply(p.totalSupply, p.decimals)}.`,
    'sui-not-coin': (p) => `El paquete ${p.package} existe, pero no se encontró ninguna moneda con ese nombre. Revisa el nombre del módulo y de la moneda.`,
    'sui-package': (p) => `Un paquete de código Move en Sui (${p.package}), no una moneda. Los resultados de abajo son los poderes que expone su código.`,
    'sui-supply-fixed': () => 'El suministro está bloqueado: nunca puede crecer ni disminuir.',
    'sui-supply-burn-only': () => 'Ya no se pueden crear más monedas; solo se pueden quemar.',
    'sui-treasury': (p) => {
      if (p.issuer) return `${p.issuer} puede hacer mint (TreasuryCap) para emitir monedas respaldadas por depósitos, como es normal en este tipo de moneda.`;
      if (p.holder) return `Todavía se pueden crear monedas nuevas: la wallet ${p.holder} tiene la llave de mint (TreasuryCap) y puede crear sin límite, diluyendo a los holders o inundando el mercado.`;
      const where = { object: 'se guarda dentro de otro contrato', shared: 'está en un objeto compartido' }[p.where] ?? 'todavía existe, pero no se encontró quién la tiene';
      return `Todavía se pueden crear monedas nuevas: la llave de mint (TreasuryCap) ${where}. Las reglas de mint dependen del código que la guarda.`;
    },
    'sui-regulated': (p) => (p.issuer
      ? `${p.issuer} puede bloquear wallets concretas (DenyCap), normalmente por fondos robados u órdenes judiciales.`
      : `Una moneda regulada: quien tiene el DenyCap${p.holder ? ` (${p.holder})` : ''} puede bloquear wallets. Una wallet bloqueada no puede usar ni vender esta moneda.`),
    'sui-global-pause': (p) => (p.issuer
      ? `${p.issuer} puede pausar todo uso de esta moneda en una emergencia.`
      : 'Quien tiene el DenyCap puede pausar esta moneda para todos a la vez (pausa global).'),
    'sui-system': () => 'Código del sistema de Sui: solo se puede actualizar por votación de los validadores.',
    'sui-upgradeable': (p) => (p.issuer
      ? `${p.issuer} puede actualizar el código del paquete, la forma habitual en que los emisores lo corrigen o amplían.`
      : `Paquete actualizable: quien tiene el UpgradeCap${p.holder ? ` (${p.holder})` : p.where === 'object' ? ' (guardado dentro de otro contrato)' : ''} puede cambiar el código (política: ${p.policy}). Lo que se revisa hoy puede no valer mañana.`),
    'sui-upgrade-cap-gone': () => 'La llave de actualización (UpgradeCap) ya no existe por separado: se destruyó, lo que hace el código permanente, o quedó bloqueada dentro de otro contrato.',
    'move-truncated': () => 'Este paquete es grande; Neuro solo revisó los primeros 50 módulos y 50 funciones por módulo.',
    'move-caveat': () => 'Revisado a partir de los nombres de las funciones y los datos en la cadena con reglas fijas. No se revisan el contenido de las funciones ni la liquidez. No es asesoramiento de inversión.',
    // Aptos
    'apt-not-found': () => 'No hay ninguna moneda ni cuenta en esta dirección en Aptos. Puede estar mal escrita, o hay otra red seleccionada.',
    'apt-not-token': (p) => (p.account ? 'Esta dirección es una cuenta de usuario en Aptos, no un token.' : 'Esta dirección es un objeto de Aptos que no es un token.'),
    'apt-token': (p) => `${p.standard} de Aptos "${p.name ?? '?'}" (${p.symbol ?? '?'}), suministro total ${fmtSupply(p.totalSupply, p.decimals)}${p.maxSupply ? `, máximo ${fmtSupply(p.maxSupply, p.decimals)}` : ''}.`,
    'apt-package': (p) => `Un paquete de código Move en Aptos (${p.address}), no un token. Los resultados de abajo son los poderes que expone su código.`,
    'apt-managed-coin': (p) => (p.issuer
      ? `${p.issuer} puede hacer mint, congelar y quemar (managed_coin), como es normal en este tipo de token.`
      : `El creador (${p.account}) tiene los poderes de mint, congelación y quema (managed_coin) y puede crear tokens en cualquier momento.`),
    'apt-mint-power': (p) => (p.issuer
      ? `${p.issuer} puede hacer mint para emitir tokens respaldados por depósitos, como es normal en este tipo de token.`
      : `El código del creador conserva el poder de mint (${list(p.structs)}). Todavía se pueden crear tokens nuevos, diluyendo a los holders.`),
    'apt-freeze-power': (p) => (p.issuer
      ? `${p.issuer} puede congelar wallets concretas, normalmente por fondos robados u órdenes judiciales.`
      : `El código del creador conserva el poder de congelar wallets (${list(p.structs)}). Una wallet congelada no puede vender ni transferir, y un TransferRef puede mover tus tokens sin permiso.`),
    'apt-burn-power': (p) => (p.issuer
      ? `${p.issuer} puede quemar tokens de cualquier wallet, algo que se usa para incautaciones legales.`
      : `El código del creador conserva el poder de quemar (${list(p.structs)}) tokens de la wallet de cualquiera.`),
    'apt-dispatch': (p) => (p.issuer
      ? `${p.issuer} ejecuta código extra en cada depósito y retiro (${list(p.functions)}).`
      : `Cada depósito y retiro ejecuta código extra (${list(p.functions)}) que puede imponer sus propias reglas, como bloquear ventas.`),
    'apt-untransferable': () => 'Los almacenes del token no pueden cambiar de dueño (untransferable). Las transferencias normales del token siguen funcionando.',
    'apt-upgradeable': (p) => (p.issuer
      ? `${p.issuer} puede actualizar el código, la forma habitual en que los emisores lo corrigen o amplían.`
      : `El código del creador (${list(p.packages)} en ${p.address}) es actualizable: esa cuenta puede cambiarlo en cualquier momento. Lo que se revisa hoy puede no valer mañana.`),
    'apt-immutable': (p) => `El código del creador (${p.address}) está marcado como inmutable: nunca puede cambiar.`,
    'apt-framework': () => 'Código del sistema de Aptos: solo se puede actualizar por votación de la red.',
    // TON
    'ton-not-found': () => 'No hay ningún contrato en esta dirección en TON (no existe o no está desplegado). Puede estar mal escrita.',
    'ton-not-jetton': (p) => {
      if (p.wallet) return 'Esta dirección es una wallet, no un token.';
      if ((p.interfaces ?? []).includes('jetton_wallet')) return 'Esta es la jetton wallet de un holder, no el token en sí. Introduce la dirección principal del token (jetton master).';
      return `Este contrato de TON no es un token${p.interfaces?.length ? ` (${list(p.interfaces)})` : ''}.`;
    },
    'ton-scam': () => 'tonapi.io (un tercero) ha puesto una etiqueta de advertencia a este token o a su cuenta admin. Es la etiqueta de tonapi.io, no un resultado de esta revisión de código; revisa su motivo antes de comprar o aceptar el token.',
    'ton-jetton': (p) => `Token de TON (jetton) "${p.name ?? '?'}" (${p.symbol ?? '?'}), suministro total ${fmtSupply(p.totalSupply, p.decimals)}${p.holders != null ? `, ${fmtSupply(p.holders, 0)} holders` : ''}.`,
    'ton-listed': () => 'Está en la lista de tokens revisados de tonapi.io (whitelist). Es la lista de un tercero, no una garantía.',
    'ton-frozen': () => 'Este contrato de token está congelado por tarifas de almacenamiento impagadas y ahora mismo no se puede usar.',
    'ton-mintable': (p) => (p.issuer
      ? `${p.issuer} puede hacer mint para emitir tokens respaldados por depósitos, como es normal en este tipo de token.`
      : `El admin (${p.admin}) todavía puede crear tokens nuevos (mint), diluyendo a los holders o inundando el mercado.`),
    'ton-admin': (p) => (p.issuer
      ? `${p.issuer} es el admin del contrato y puede cambiar los datos del token.`
      : `Un admin (${p.admin}) todavía puede cambiar el nombre y el logo y, si el código del contrato no es estándar, puede tener otros poderes que esta revisión no ve.`),
    'ton-admin-dropped': () => 'Se renunció al rol de admin: ya nadie puede crear tokens ni cambiar los datos del token.',
    'ton-mint-flag': () => 'El contrato todavía dice que se puede hacer mint, pero no hay ningún admin que pueda hacerlo.',
    'ton-caveat': () => 'Revisado a partir de los datos del contrato decodificados por tonapi.io con reglas fijas; la wallet de los holders se revisa según lo que reconoce tonapi, no línea por línea. No es asesoramiento de inversión.',
    'ton-wallet-standard': (p) => `Los tokens de los holders están en una jetton wallet estándar que tonapi.io reconoce (${list(p.interfaces)}).`,
    'ton-wallet-custom': (p) => (p.issuer
      ? `${p.issuer} usa su propio código de jetton wallet, como es normal en este token.`
      : `Los tokens de los holders están en un código de wallet que tonapi.io no reconoce como jetton wallet estándar${p.compiler ? ` (${p.compiler})` : ''}. Un código de wallet personalizado puede negarse a enviar, así que puede que puedas comprar pero no vender. Hash del código: ${p.codeHash ?? '?'}.`),
    // Solana programs (Anchor IDL)
    'sol-idl': (p) => `Este programa está escrito en Rust (Anchor) y publica su lista de instrucciones en la cadena: ${p.name ?? '?'}, ${p.count ?? '?'} instrucciones.`,
    'sol-admin-instructions': (p) => `Instrucciones que necesitan la firma de un admin (${list(p.functions)}). El admin puede usarlas para cambiar cómo se comporta el programa.`,
    'sol-no-idl': () => 'Este programa no publica su lista de instrucciones (Anchor IDL) en la cadena, así que no se puede leer qué puede hacer.',
    // EVM code that is not EVM bytecode
    'stylus-code': (p) => (p.issuer
      ? `${p.issuer} usa un contrato Stylus (Rust/C++ compilado a WASM en Arbitrum), que las reglas de Neuro aún no pueden leer.`
      : 'Un contrato Stylus (Rust o C++ compilado a WASM en Arbitrum). Las reglas de Neuro aún no pueden leer este código, así que no se sabe si puede hacer mint, bloquear o pausar. Trátalo como no revisado.'),
    'stylus-read': (p) => `Un contrato Stylus (Rust o C++ compilado a WASM en Arbitrum). Neuro desempaquetó su código WASM (${fmtSupply(p.size, 0)} bytes) y encontró ${p.count ?? 0} función(es) conocida(s); los resultados de abajo salen de ellas. Pueden pasarse por alto nombres de función poco comunes.`,
    'unknown-code-format': (p) => (p.issuer
      ? `${p.issuer} usa código que no es bytecode EVM estándar.`
      : 'El código de este contrato no es bytecode EVM estándar y las reglas de Neuro no pueden leerlo. Trátalo como no revisado.'),
    'eip7702': (p) => `Esta dirección es una wallet normal cuyo dueño la configuró para ejecutar el código del contrato ${p.target} (EIP-7702). No es un token. Ese código puede hacer con los fondos de la wallet lo que esté programado para hacer; revisa también ${p.target}.`,
    'source-verified': (p) => `Código fuente público que Sourcify confirmó que ${p.match === 'exact' ? 'coincide byte a byte con el código en la cadena' : 'coincide con el código en la cadena'} (${[p.name, p.language, p.compiler].filter(Boolean).join(', ')}). Léelo en ${p.url}`,
    'source-unverified': () => 'No hay código fuente en Sourcify. Puede que esté publicado en el explorador de la red; si no está publicado en ningún sitio, ten mucho cuidado.',
    // Trade simulation (buy/sell test, src/honeypot.js)
    'sim-cannot-sell': (p) => `La prueba de venta falló: en una operación simulada a través de ${p.dex}, la compra funcionó pero la venta ${p.sell == null ? 'falló' : `devolvió casi nada (se perdió un ${p.sell}%)`}. Si compras, puede que no puedas vender. (Algunos tokens bloquean la venta solo justo después de una compra; esta revisión no puede distinguir los dos casos.)`,
    'sim-high-tax': (p) => (p.buy >= 100 && p.sell == null
      ? `Una compra simulada a través de ${p.dex} no entregó ningún token: se quedó con toda la compra.`
      : `Una operación simulada a través de ${p.dex} perdió un ${p.buy ?? '?'}% al comprar y un ${p.sell ?? '?'}% al vender, que el token se quedó como impuesto. Recibes eso de menos respecto a lo que sugiere el precio.`),
    'sim-ok': (p) => `Una compra y venta simulada de una cantidad pequeña a través de ${p.dex} funcionó (impuesto: ${p.buy}% compra, ${p.sell}% venta). Es una prueba solo en el bloque actual: quien controla el contrato aún puede subir el impuesto o bloquear la venta más adelante.`,
    'sim-skipped': (p) => ({
      'no-pool': `No se encontró ningún pool de ${p.dex} que empareje este token con ${p.native}, así que no se hizo la prueba de compra y venta. Esto por sí solo no es una señal de alarma; el token puede cotizar en otro sitio.`,
      'no-override': 'El RPC público no permitió una operación simulada (state override), así que no se hizo la prueba de compra y venta.',
      'buy-failed': `Una compra simulada a través de ${p.dex} falló, así que no se pudo probar la venta. Puede que el trading aún no esté abierto, o que el token rechace compras desde contratos.`,
    })[p.why] ?? 'No se pudo hacer la operación simulada, así que no se probaron la compra ni la venta.',
    // CosmWasm (Osmosis, Neutron)
    'cw-not-found': () => 'No hay ningún contrato ni token en esta dirección en esta red. Puede estar mal escrita, o hay otra red seleccionada.',
    'cw20-token': (p) => `Token CW20 (un contrato en Rust sobre CosmWasm) "${p.name ?? '?'}" (${p.symbol ?? '?'}), suministro total ${fmtSupply(p.totalSupply, p.decimals)}.`,
    'cw-contract': (p) => `Un contrato CosmWasm (escrito en Rust)${p.label ? ` llamado "${p.label}"` : ''}, code ID ${p.codeId ?? '?'}. No es un token CW20.`,
    'cw-admin': (p) => `El admin (${p.admin}) puede reemplazar el código del contrato por código nuevo en cualquier momento (migrate). Lo que se revisa hoy puede no valer mañana.`,
    'cw-no-admin': () => 'Sin admin: el código del contrato nunca se puede reemplazar.',
    'cw-migrated': (p) => `El código de este contrato ya se ha reemplazado ${p.count} vez/veces.`,
    'cw20-minter': (p) => `${p.minter} todavía puede crear tokens nuevos (mint)${p.cap ? `, hasta ${fmtSupply(p.cap, p.decimals)} en total` : ' sin límite'}, diluyendo a los holders o inundando el mercado.`,
    'cw20-no-minter': () => 'Nadie puede crear más de este token.',
    'tf-token': (p) => `Moneda de Token Factory "${p.name ?? '?'}"${p.symbol ? ` (${p.symbol})` : ''} creada por ${p.creator}, suministro total ${fmtSupply(p.totalSupply, p.decimals)}.`,
    'tf-admin': (p) => `El admin (${p.admin}) puede hacer mint sin límite y, en algunas redes, también mover o quemar tokens de las wallets de otras personas.`,
    'tf-no-admin': () => 'Se renunció al rol de admin: nadie puede crear más.',
    'tf-hook': (p) => `Cada transferencia debe pasar por el contrato ${p.contract} (before-send hook), que puede imponer sus propias reglas, como bloquear ventas.`,
    'cw-caveat': () => 'Revisado a partir de los datos del contrato en la cadena con reglas fijas. No se revisan el código Rust interno ni la liquidez. No es asesoramiento de inversión.',
    // NEAR
    'near-not-found': () => 'No hay ninguna cuenta con este nombre en NEAR. Puede estar mal escrita, o hay otra red seleccionada.',
    'near-no-contract': () => 'Esta cuenta de NEAR es una cuenta normal sin contrato. No es un token.',
    'near-token': (p) => `Token de NEAR (NEP-141) "${p.name ?? '?'}" (${p.symbol ?? '?'}), suministro total ${fmtSupply(p.totalSupply, p.decimals)}.`,
    'near-contract': (p) => `Un contrato de NEAR (código WASM, p. ej. de Rust) con ${p.count ?? '?'} funciones públicas. No es un token NEP-141.`,
    'near-full-access': (p) => (p.issuer
      ? `${p.issuer} todavía tiene una clave de acceso total a la cuenta del contrato, así que puede cambiar el código, la forma habitual en que los emisores lo corrigen o amplían.`
      : `La cuenta del contrato todavía tiene ${p.count} clave(s) de acceso total: quien tenga una puede desplegar código nuevo encima en cualquier momento. Lo que se revisa hoy puede no valer mañana.`),
    'near-locked': () => 'La cuenta del contrato no tiene claves de acceso total: nadie puede desplegar código nuevo encima desde fuera.',
    'near-upgrade-method': (p) => (p.issuer
      ? `${p.issuer} puede actualizar el código mediante una función del contrato (${list(p.functions)}).`
      : `El código tiene funciones que pueden reemplazar su propio código (${list(p.functions)}). Incluso sin una clave de acceso total, quien pueda llamarlas puede cambiarlo.`),
    'near-caveat': () => 'Revisado a partir de los nombres de las funciones en el código WASM y los datos de la cuenta en la cadena con reglas fijas. No se lee el contenido de las funciones. No es asesoramiento de inversión.',
    // Starknet (Cairo)
    'sn-not-found': () => 'No hay ningún contrato en esta dirección en Starknet. Puede estar mal escrita, o hay otra red seleccionada.',
    'sn-token': (p) => `Token de Starknet "${p.name ?? '?'}" (${p.symbol ?? '?'}), suministro total ${fmtSupply(p.totalSupply, p.decimals)}.`,
    'sn-contract': (p) => `Un contrato de Starknet (escrito en Cairo ${p.cairo === 1 ? '1' : '0'}) con ${p.count ?? '?'} funciones en su ABI. No es un token.`,
    'sn-upgradeable': (p) => (p.issuer
      ? `${p.issuer} puede actualizar el código del contrato, la forma habitual en que los emisores lo corrigen o amplían.`
      : `Actualizable${p.implementation ? ` (un proxy que apunta al código ${p.implementation})` : ''}${p.functions?.length ? ` mediante ${list(p.functions)}` : ''}: quien tenga permiso puede reemplazar todo el código. Lo que se revisa hoy puede no valer mañana.`),
    'sn-caveat': () => 'Revisado a partir del ABI que el contrato publica en la cadena (nombres de funciones y si cambian el estado) con reglas fijas. No se lee el contenido de las funciones. No es asesoramiento de inversión.',
    // Bitcoin (Runes)
    'btc-not-found': () => 'No hay ninguna Rune con este nombre o id en Bitcoin. Una Rune es un nombre como DOG•GO•TO•THE•MOON o un id como 840000:3. Los tokens BRC-20 aún no se leen.',
    'btc-rune': (p) => `Rune de Bitcoin "${p.name ?? '?'}"${p.symbol ? ` (${p.symbol})` : ''}, id ${p.id ?? '?'}, suministro hasta ahora ${fmtSupply(p.totalSupply, p.decimals)}.`,
    'btc-no-admin': () => 'Los tokens de Bitcoin no tienen código de contrato ni owner: nadie puede congelar, poner en lista negra, pausar, cobrar impuestos ni cambiar este token. Sus reglas quedaron fijadas al crearse.',
    'btc-open-mint': (p) => (p.unlimited
      ? 'Cualquiera puede seguir haciendo mint, sin tope ni fecha de fin, así que el suministro puede seguir creciendo sin límite.'
      : `El mint sigue abierto: cualquiera puede crear más hasta ${p.end ? `el bloque ${p.end} o ` : ''}${p.maxSupply ? `que se alcance el máximo de ${fmtSupply(p.maxSupply, p.decimals)}` : 'que termine el periodo de mint'}${p.percent != null ? ` (${p.percent}% creado hasta ahora)` : ''}. El suministro sigue creciendo.`),
    'btc-premine': (p) => `El ${p.percent}% del suministro máximo fue para el creador al crearse el token (premine). Puede venderlo en cualquier momento.`,
    'btc-turbo': () => 'El creador aceptó futuros cambios del protocolo Runes (turbo), así que el funcionamiento de este token puede cambiar con nuevas versiones del protocolo.',
    'btc-caveat': () => 'Leído de ord (ordinals.com), el indexador de referencia de Runes, con reglas fijas. Las Runes existen como reglas del indexador sobre Bitcoin. No se revisan los holders ni la liquidez. No es asesoramiento de inversión.',
};
