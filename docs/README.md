# nekto-me-mitm

Управляйте двумя разговорами Nekto.me из единой панели: переключайте собеседников, используйте Soundpad и включайте свой микрофон в нужный момент.

<p align="center">
  <img src="images/control-panel.png" alt="nekto-me-mitm screen" width="100%">
</p>

## Что такое MITM?

**MITM** (*Man-in-the-Middle*, «человек посередине») означает, что расширение становится посредником между двумя собеседниками: передаёт их голоса друг другу и при необходимости добавляет ваш микрофон и Soundpad.

## Схема аудиомаршрута

```mermaid
flowchart LR
    A["Собеседник A"]
    B["Собеседник B"]
    M["Ваш<br/>микрофон"]
    S["Soundpad"]
    R["Audio Router<br/>локальная панель"]
    O["Вы"]

    A -->|"входящий трек A"| R
    B -->|"входящий трек B"| R
    M -.-> R
    S -.-> R
    R -->|"B + микрофон + Soundpad"| A
    R -->|"A + микрофон + Soundpad"| B
    R -->|"A + B + Soundpad"| O

    classDef tab fill:#17181b,stroke:#4ade80,color:#f3f1eb,stroke-width:2px
    classDef source fill:#121315,stroke:#f6821f,color:#f3f1eb,stroke-width:2px
    classDef bridge fill:#f6821f,stroke:#ff9843,color:#111214,stroke-width:3px
    classDef monitor fill:#17181b,stroke:#85878d,color:#f3f1eb,stroke-width:2px

    class A,B tab
    class M,S source
    class R bridge
    class O monitor

    linkStyle 0,1 stroke:#4ade80,stroke-width:2px
    linkStyle 2,3 stroke:#f6821f,stroke-width:2px,stroke-dasharray:5 5
    linkStyle 4,5 stroke:#f6821f,stroke-width:2px
    linkStyle 6 stroke:#85878d,stroke-width:2px
```

## Структура расширения

```text
nekto-me/
├── manifest.json              — конфигурация и порядок загрузки
├── background.js              — вкладки, команды и WebRTC-сигналинг
├── control.html               — панель
├── control.css                — оформление интерфейса
├── control.js                 — управление разговорами и Soundpad
├── modules/
│   ├── fpt.js                 — fingerprint
│   ├── tab-isolation.js       — изоляция вкладок
│   ├── audio-inj.js           — захват и подмена аудиотреков
│   ├── audio-router.js        — маршрутизация и микширование
│   ├── control-inj.js         — управление страницами Nekto.me
│   └── bridge.js              — связь страницы с расширением
├── rules/
│   └── soundpad-network.json  — правила Soundpad
└── docs/
    ├── README.md              — документация проекта
    └── images/                — изображения для README
```
