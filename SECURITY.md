# Política de Seguridad

Este documento describe la política de seguridad y el procedimiento para reportar vulnerabilidades en **pi-auto-compaction**.

---

## 1. Alcance y Naturaleza del Proyecto

Este repositorio es público como *source-available*: el código puede leerse y auditarse, pero está licenciado como `UNLICENSED` (todos los derechos reservados). `package.json` mantiene `private: true` y no se publica en npm.

- **Sin avisos públicos de seguridad**: No se publican avisos de seguridad (GitHub Security Advisories) ni se mantiene un programa público de recompensas por errores (bug bounty).
- **Reportes por canal privado**: Aunque el repositorio sea público, los reportes de vulnerabilidades se envían por el canal privado descrito abajo, no como issue público, para evitar divulgar un fallo antes de que exista corrección.

---

## 2. Reporte de Vulnerabilidades

Si identifica una debilidad de seguridad, fuga potencial de información o fallo en el aislamiento de credenciales:

1. **Contacto privado directo**: Póngase en contacto directamente con el propietario del repositorio (Wilkin) a través de sus canales privados de comunicación.
2. **Contenido del reporte**:
   - Descripción detallada del hallazgo.
   - Pasos para reproducir el problema en un entorno de desarrollo aislado sin credenciales reales.
   - Análisis de impacto potencial.
3. **Manejo responsable**: Se solicita no divulgar ningún detalle técnico hasta que el problema haya sido corregido y desplegado en los entornos autorizados.

---

## 3. Modelo de Privacidad y Manejo de Datos

Para minimizar cualquier riesgo de filtración de información:

### Telemetría local
- Los registros de compactación se almacenan localmente en `$HOME/.local/state/pi-auto-compaction/compaction.jsonl`.
- El archivo se crea con permisos estrictos `0600` (lectura/escritura exclusiva del usuario) dentro de un directorio con permisos `0700`.
- **Lista blanca de campos**: Se registran únicamente métricas operativas cuantitativas (marca de tiempo, identificador de sesión, motivo, modelo resumidor, estado, duración en milisegundos, tokens antes de compactar `tokensBefore`, uso de tokens si está disponible, conteo de intentos, categoría de error) y metadatos del contexto de conversación (modelo y proveedor de conversación, ventana de contexto, `reserveTokens`, `keepRecentTokens` y `thresholdTokens`). **No se registra `tokensAfter`**.
- **Datos expresamente excluidos**: El sistema filtra y descarta de forma terminante transcripciones de chat, claves de API, tokens de sesión, variables de entorno y rutas completas del sistema de archivos.

### Transmisión hacia resumidores de OmniRoute
- Para que la compactación automática pueda generar un resumen del contexto anterior, **el texto de los turnos antiguos de la conversación es transmitido deliberadamente a la API de OmniRoute**.
- El uso de HTTPS/TLS depende de la configuración del proveedor (por ejemplo, el esquema URL del endpoint en Pi u OmniRoute); la extensión no impone ni garantiza TLS a nivel de transporte, pero se recomienda enfáticamente utilizar endpoints HTTPS.
- No debe asumirse que los datos conversacionales permanecen estrictamente dentro de la máquina local durante el ciclo de compactación; la garantía de privacidad local aplica al archivo de telemetría y a los journals, que nunca almacenan el contenido de los mensajes.
- Los modelos resumidores configurados (`gemini-3.8-flash-tiered` y `gemini-3.6-flash-high`) reciben únicamente los mensajes necesarios para sintetizar el contexto histórico.

### Separación de credenciales
- El repositorio no almacena credenciales, tokens ni configuraciones de autenticación.
- Todas las claves de API residen en los almacenes nativos de Pi (`$HOME/.pi/agent/auth.json`) con las protecciones de acceso estándar del sistema operativo.
- Pi valida las credenciales de autenticación del modelo de conversación en `auth.json` antes de emitir los hooks de compactación. Los errores de credenciales previenen la invocación del hook, mientras que los errores de cuota o servicio de proveedores ocurren en fases posteriores.
