# MovieTracker - System Śledzenia Filmów i Seriali

> Nowoczesna aplikacja webowa do zarządzania listą obejrzanych filmów i seriali z zaawansowanym systemem śledzenia odcinków, wyzwań i odznak.

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Status](https://img.shields.io/badge/status-active-success.svg)

---

## Spis Treści

- [O Projekcie](#o-projekcie)
- [Główne Funkcje](#-główne-funkcje)
- [Architektura Techniczna](#-architektura-techniczna)
- [Technologie](#-technologie)
- [Funkcjonalności](#-funkcjonalności)
- [Bezpieczeństwo](#-bezpieczeństwo)

---

## O Projekcie

**Movie Tracker** to kompleksowa aplikacja webowa zaprojektowana dla miłośników filmów i seriali. System umożliwia użytkownikom katalogowanie obejrzanych treści, śledzenie postępów w serialach z dokładnością do pojedynczych odcinków, uczestnictwo w wyzwaniach filmowych oraz zdobywanie odznak za osiągnięcia.

### Cel Projektu

Stworzenie intuicyjnej platformy, która:
- Centralizuje informacje o filmach i serialach użytkownika
- Gamifikuje doświadczenie oglądania poprzez system wyzwań i odznak
- Umożliwia budowanie społeczności poprzez system znajomych

---

## Główne Funkcje

### Zarządzanie Treściami
- **Wyszukiwanie filmów i seriali** - W własnej bazie danych
- **Kategorie statusów**: Obejrzane, Obecnie oglądane, Planowane, Porzucone
- **System ocen** - ocena od 1 do 5 gwiazdek
- **Recenzje** - pisanie własnych opinii o filmach

### Zaawansowane Śledzenie Seriali
- **Śledzenie odcinków** - dokładność do pojedynczego odcinka
- **Zarządzanie sezonami** - konfiguracja liczby odcinków per sezon
- **Automatyczna aktualizacja statusu** - serial zmienia status w zależności od postępu
- **Wsparcie dla zakresów lat** - np. "2008-2013" dla seriali wieloletnich

### System Wyzwań i Odznak
- **Wyzwania filmowe** - np. "Obejrzyj 10 filmów akcji w miesiąc"
- **Odznaki za osiągnięcia** - z poziomami: Silver, Gold, Platinum
- **Śledzenie postępu** - wizualizacja postępu w wyzwaniach
- **Historia odznak** - zapis zdobytych osiągnięć z datami

### System Społecznościowy
- **Znajomi** - dodawanie i zarządzanie kontaktami
- **Zaproszenia** - system zaproszeń do znajomych
- **Porównywanie statystyk** - konkurowanie z przyjaciółmi

### Dashboard i Statystyki
- **Liczba obejrzanych filmów** - filtrowanie po typie (film lub serial)
- **Całkowity czas** - suma godzin spędzonych na oglądaniu
- **Średnia ocena** - automatycznie wyliczana średnia z ocen
- **Wykres aktywności** - wizualizacja aktywności w czasie

---

## Technologie

### Frontend Stack
| Technologia | Wersja | Zastosowanie |
|------------|--------|--------------|
| **HTML5** | - | Struktura aplikacji |
| **CSS3** | - | Style i animacje |
| **JavaScript (ES6+)** | - | Logika aplikacji |
| **Font Awesome** | 6.4.0 | Ikony |
| **Chart.js** | 4.4.0 | Wykresy statystyk |

### Backend Stack
| Technologia | Zastosowanie |
|------------|--------------|
| **Cloudflare Pages** | Hosting aplikacji |
| **Cloudflare Functions** | Serverless API |
| **Cloudflare D1** | Baza danych SQLite |
| **Cloudflare R2** | Object storage |

---

## Autor

Dawid Łyczko

---

## Licencja

MIT License - szczegóły w pliku `LICENSE`

---


