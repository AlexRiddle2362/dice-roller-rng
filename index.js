// Dice Roller (RNG Injector) для SillyTavern
//
// Идея: перед КАЖДОЙ генерацией ответа ИИ расширение бросает кубик
// (по умолчанию d20), используя формулу на основе текущего момента времени,
// и вставляет результат в чат как служебное сообщение прямо перед последней
// репликой пользователя. ИИ видит бросок в контексте и учитывает его в
// повествовании (успех/провал/помеха/преимущество — по вкусу вашего пресета).
//
// Никаких обращений к ИИ для получения броска не происходит: вся генерация
// числа — чистый JavaScript, ноль токенов.

const MODULE_NAME = 'dice_roller_rng';

const defaultSettings = Object.freeze({
    enabled: true,
    dieSides: 20,
    modifier: 0,
    showToast: true,
    skipTypes: 'quiet',
    template: '🎲 Бросок {{die}}{{modifier_str}}: {{raw}} → итог {{total}}{{label}}',
});

function getSettings() {
    const { extensionSettings } = SillyTavern.getContext();
    if (!extensionSettings[MODULE_NAME]) {
        extensionSettings[MODULE_NAME] = structuredClone(defaultSettings);
    }
    for (const key of Object.keys(defaultSettings)) {
        if (!Object.hasOwn(extensionSettings[MODULE_NAME], key)) {
            extensionSettings[MODULE_NAME][key] = defaultSettings[key];
        }
    }
    return extensionSettings[MODULE_NAME];
}

// ---------------------------------------------------------------------
// RNG: сид берётся из текущего высокоточного времени (мс + доли мс с
// момента загрузки страницы), затем прогоняется через mulberry32 —
// компактный, хорошо перемешивающий генератор псевдослучайных чисел.
//
// Честно: криптографической стойкости это не даёт и не обязано —
// Math.random() для игральных костей справился бы ничуть не хуже.
// Смысл именно такой схемы — прозрачная, детерминированная формула
// "момент времени -> число", а не чёрный ящик движка.
// ---------------------------------------------------------------------

function mulberry32(seed) {
    return function () {
        seed |= 0;
        seed = (seed + 0x6D2B79F5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function timeSeed() {
    const hiRes = performance.timeOrigin + performance.now(); // мс от эпохи, с долями мс
    const ms = Math.floor(hiRes);
    const frac = Math.floor((hiRes - ms) * 1e6); // "микросекундная" дробная часть
    // Второй независимый отсчёт времени — чтобы два броска, попавшие
    // в одну и ту же миллисекунду, всё равно давали разные сиды
    const jitter = Math.floor(performance.now() * 1000) & 0xffff;
    return (ms ^ (frac << 6) ^ (jitter << 13)) >>> 0;
}

function rollDie(sides) {
    const rand = mulberry32(timeSeed())();
    return 1 + Math.floor(rand * sides);
}

// ---------------------------------------------------------------------
// Формирование текста сообщения
// ---------------------------------------------------------------------

function buildRollText(settings, sides, raw) {
    const modifier = Number(settings.modifier) || 0;
    const total = raw + modifier;
    const modifierStr = modifier === 0 ? '' : (modifier > 0 ? ` +${modifier}` : ` ${modifier}`);

    let label = '';
    if (raw === sides) label = ' — КРИТИЧЕСКИЙ УСПЕХ';
    else if (raw === 1) label = ' — КРИТИЧЕСКИЙ ПРОВАЛ';

    return settings.template
        .replaceAll('{{die}}', `d${sides}`)
        .replaceAll('{{raw}}', String(raw))
        .replaceAll('{{modifier}}', String(modifier))
        .replaceAll('{{modifier_str}}', modifierStr)
        .replaceAll('{{total}}', String(total))
        .replaceAll('{{label}}', label);
}

// ---------------------------------------------------------------------
// Перехватчик генерации — официальный механизм SillyTavern
// (поле generate_interceptor в manifest.json). Вызывается движком
// синхронно перед сборкой промпта, ДО обращения к ИИ.
// chat — мутируемый массив истории чата; всё, что мы туда допишем,
// попадёт и в промпт, и в видимую историю чата.
// ---------------------------------------------------------------------

globalThis.diceRollerInterceptor = async function (chat, contextSize, abort, type) {
    const settings = getSettings();
    if (!settings.enabled) return;

    const skip = settings.skipTypes.split(',').map(s => s.trim()).filter(Boolean);
    if (skip.includes(type)) return;

    const sides = Number(settings.dieSides) || 20;
    const raw = rollDie(sides);
    const text = buildRollText(settings, sides, raw);

    chat.push({
        is_user: false,
        is_system: true,
        name: 'Dice Roller',
        send_date: Date.now(),
        mes: text,
        extra: { isSmallSys: true, dice_roller: { sides, raw } },
    });

    if (settings.showToast) {
        toastr.info(text, 'Dice Roller', { timeOut: 2500 });
    }
};

// ---------------------------------------------------------------------
// Панель настроек
// ---------------------------------------------------------------------

function bindSettingsUI() {
    const settings = getSettings();
    const { saveSettingsDebounced } = SillyTavern.getContext();

    $('#dice_roller_enabled').prop('checked', settings.enabled).on('change', function () {
        settings.enabled = $(this).prop('checked');
        saveSettingsDebounced();
    });

    $('#dice_roller_sides').val(settings.dieSides).on('input', function () {
        settings.dieSides = Number($(this).val()) || 20;
        saveSettingsDebounced();
    });

    $('#dice_roller_modifier').val(settings.modifier).on('input', function () {
        settings.modifier = Number($(this).val()) || 0;
        saveSettingsDebounced();
    });

    $('#dice_roller_toast').prop('checked', settings.showToast).on('change', function () {
        settings.showToast = $(this).prop('checked');
        saveSettingsDebounced();
    });

    $('#dice_roller_skip').val(settings.skipTypes).on('input', function () {
        settings.skipTypes = $(this).val();
        saveSettingsDebounced();
    });

    $('#dice_roller_template').val(settings.template).on('input', function () {
        settings.template = $(this).val();
        saveSettingsDebounced();
    });

    $('#dice_roller_test').on('click', function () {
        const sides = Number(settings.dieSides) || 20;
        const raw = rollDie(sides);
        toastr.info(buildRollText(settings, sides, raw), 'Dice Roller (тест)', { timeOut: 4000 });
    });
}

jQuery(async () => {
    const { renderExtensionTemplateAsync } = SillyTavern.getContext();
    const settingsHtml = await renderExtensionTemplateAsync('third-party/dice-roller-rng', 'settings');
    $('#extensions_settings2').append(settingsHtml);
    bindSettingsUI();
});
