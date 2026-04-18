<?php
if (file_exists(__DIR__ . '/dist/index.html')) {
    echo file_get_contents(__DIR__ . '/dist/index.html');
} else {
    echo "<h1>Error</h1><p>Please run <code>npm run build</code> first. Production build missing.</p>";
}
