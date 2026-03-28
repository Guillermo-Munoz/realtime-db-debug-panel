<?php
/**
 * db-debug.php
 *
 * Endpoint de depuración genérico para inspección en tiempo real
 * de cualquier tabla de la base de datos.
 *
 * Parámetros GET aceptados:
 *   table  (obligatorio) — nombre de la tabla a consultar
 *   cols   (opcional)    — columnas a devolver, separadas por comas (default: *)
 *   where  (opcional)    — condición WHERE en texto plano (solo para dev, no sanitizado)
 *   order  (opcional)    — columna por la que ordenar
 *   dir    (opcional)    — dirección de ordenación: ASC | DESC (default: DESC)
 *   limit  (opcional)    — número máximo de filas (default: 50, máximo: 200)
 *   host   (opcional)    — host de la BD (default: localhost)
 *   user   (opcional)    — usuario de la BD (default: root)
 *   pass   (opcional)    — contraseña de la BD (default: vacío)
 *   db     (opcional)    — nombre de la BD (default: test_db)
 *
 * Ejemplo de uso:
 *   /db-debug.php?table=orders&cols=id,reference,total,status&order=id&limit=25
 *   /db-debug.php?table=customers&host=192.168.1.5&user=admin&pass=secret&db=prod_db
 *
 * ADVERTENCIA: Este endpoint expone datos de la base de datos sin autenticación.
 *              Usar exclusivamente en entornos de desarrollo local.
 *              Nunca desplegar en producción.
 */

header('Content-Type: application/json');

// ---------------------------------------------------------------------------
// Configuración de conexión — puede venir de GET o usar defaults
// ---------------------------------------------------------------------------

$host = $_GET['host'] ?? 'localhost';
$user = $_GET['user'] ?? 'root';
$pass = $_GET['pass'] ?? '';
$db   = $_GET['db']   ?? 'test_db';

// Validación básica de parámetros de conexión para prevenir inyección
if (!preg_match('/^[a-zA-Z0-9\.\-_]+$/', $host)) {
    http_response_code(400);
    echo json_encode(['error' => 'Invalid host parameter. Only alphanumeric characters, dots, hyphens and underscores allowed.']);
    exit;
}

if (!preg_match('/^[a-zA-Z0-9_\-\.]+$/', $user)) {
    http_response_code(400);
    echo json_encode(['error' => 'Invalid user parameter.']);
    exit;
}

if (!preg_match('/^[a-zA-Z0-9_\-\.]+$/', $db)) {
    http_response_code(400);
    echo json_encode(['error' => 'Invalid database parameter.']);
    exit;
}

// ---------------------------------------------------------------------------
// Validación de parámetros de entrada
// ---------------------------------------------------------------------------

if (empty($_GET['table'])) {
    http_response_code(400);
    echo json_encode(['error' => 'Missing required parameter: table']);
    exit;
}

// Validamos que el nombre de tabla solo contenga caracteres alfanuméricos y guiones bajos
// para prevenir inyección SQL en el identificador de tabla.
$table = $_GET['table'];
if (!preg_match('/^[a-zA-Z0-9_]+$/', $table)) {
    http_response_code(400);
    echo json_encode(['error' => 'Invalid table name. Only alphanumeric characters and underscores are allowed.']);
    exit;
}

// Procesamiento de columnas: validamos cada nombre individualmente
$cols = '*';
if (!empty($_GET['cols'])) {
    $requestedCols = array_map('trim', explode(',', $_GET['cols']));
    $safeCols      = array_filter($requestedCols, fn($c) => preg_match('/^[a-zA-Z0-9_]+$/', $c));

    if (count($safeCols) !== count($requestedCols)) {
        http_response_code(400);
        echo json_encode(['error' => 'One or more column names contain invalid characters.']);
        exit;
    }

    $cols = implode(', ', $safeCols);
}

// Límite de filas: forzamos entero y aplicamos tope máximo
$limit = 50;
if (!empty($_GET['limit'])) {
    $limit = min(200, max(1, intval($_GET['limit'])));
}

// Columna de ordenación: validación de caracteres
$order = '';
if (!empty($_GET['order'])) {
    $orderCol = trim($_GET['order']);
    if (preg_match('/^[a-zA-Z0-9_]+$/', $orderCol)) {
        $direction = strtoupper($_GET['dir'] ?? 'DESC');
        $direction = in_array($direction, ['ASC', 'DESC']) ? $direction : 'DESC';
        $order     = "ORDER BY {$orderCol} {$direction}";
    }
}

// Condición WHERE en texto plano.
// NOTA: Este parámetro no está sanitizado más allá de la longitud máxima.
//       Es deliberado para permitir condiciones arbitrarias en depuración,
//       pero implica que este endpoint NUNCA debe estar accesible en producción.
$where = '';
if (!empty($_GET['where'])) {
    $rawWhere = substr($_GET['where'], 0, 500);
    $where    = "WHERE {$rawWhere}";
}

// ---------------------------------------------------------------------------
// Conexión
// ---------------------------------------------------------------------------

$conn = new mysqli($host, $user, $pass, $db);

if ($conn->connect_error) {
    http_response_code(500);
    echo json_encode([
        'error' => 'Database connection failed: ' . $conn->connect_error,
        'connection_params' => ['host' => $host, 'user' => $user, 'db' => $db]
    ]);
    exit;
}

// Verificamos que la tabla existe antes de consultar para devolver un error claro
$tableCheck = $conn->query("SHOW TABLES LIKE '{$table}'");
if (!$tableCheck || $tableCheck->num_rows === 0) {
    http_response_code(404);
    echo json_encode(['error' => "Table '{$table}' does not exist in database '{$db}'."]);
    $conn->close();
    exit;
}

// ---------------------------------------------------------------------------
// Detección automática de clave primaria
// Permite que el panel JS identifique unívocamente cada fila para el diff
// sin necesidad de configuración manual por tabla.
// ---------------------------------------------------------------------------

$primaryKey = null;
$keysResult = $conn->query("SHOW KEYS FROM `{$table}` WHERE Key_name = 'PRIMARY'");
if ($keysResult && $keysResult->num_rows > 0) {
    $keyRow     = $keysResult->fetch_assoc();
    $primaryKey = $keyRow['Column_name'];
}

// Si la tabla no tiene PK definida, usamos la primera columna como fallback
if (!$primaryKey) {
    $colsResult = $conn->query("SHOW COLUMNS FROM `{$table}`");
    if ($colsResult && $colsResult->num_rows > 0) {
        $firstCol   = $colsResult->fetch_assoc();
        $primaryKey = $firstCol['Field'];
    }
}

// ---------------------------------------------------------------------------
// Consulta principal
// ---------------------------------------------------------------------------

$sql    = "SELECT {$cols} FROM `{$table}` {$where} {$order} LIMIT {$limit}";
$result = $conn->query($sql);

if (!$result) {
    http_response_code(500);
    echo json_encode(['error' => 'Query failed: ' . $conn->error, 'sql' => $sql]);
    $conn->close();
    exit;
}

// ---------------------------------------------------------------------------
// Construcción de la respuesta
// ---------------------------------------------------------------------------

$data = [];
while ($row = $result->fetch_assoc()) {
    $data[] = $row;
}

// Incluimos metadatos en la respuesta para que el panel JS pueda renderizarse
// de forma dinámica sin conocer la estructura de la tabla de antemano.
$response = [
    'meta' => [
        'table'       => $table,
        'primary_key' => $primaryKey,    // Clave primaria detectada automáticamente
        'cols'        => $cols === '*' ? array_keys($data[0] ?? []) : explode(', ', $cols),
        'count'       => count($data),
        'limit'       => $limit,
        'sql'         => $sql,
        'connection'  => ['host' => $host, 'db' => $db, 'user' => $user], // Info de conexión en respuesta
    ],
    'rows' => $data,
];

// Snapshot local opcional para análisis post-mortem
$snapshotPath = sys_get_temp_dir() . "/db_debug_{$table}.json";
file_put_contents($snapshotPath, json_encode($response, JSON_PRETTY_PRINT));

echo json_encode($response);

$conn->close();
