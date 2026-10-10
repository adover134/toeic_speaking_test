# 토익 스피킹 연습 (PWA)

시험 형식 타이머(준비/답변) + 녹음 + 기록. 정적 파일이라 빌드 없이 GitHub Pages로 배포한다.

## 로컬 실행
`python3 -m http.server 8123` 후 http://localhost:8123 (마이크는 localhost 또는 HTTPS에서만 동작)

## 배포
저장소 Settings > Pages > Branch: main / root. 폰에서 URL 접속 후 "홈 화면에 추가".

## 문제 추가
`questions.json`의 `read` / `respond`(주제 + 질문 3개) / `opinion` 배열에 항목 추가.

## 라이선스 및 고지
- 코드와 `questions.json`의 연습 문제는 직접 작성한 것이며 MIT 라이선스를 따른다 (`LICENSE`).
- 이 프로젝트는 ETS와 무관한 비공식 연습 도구이다. TOEIC®은 ETS의 등록 상표이며, 실제 시험 문제를 포함하지 않는다.
- 문제를 추가할 때 공식 교재·기출 문제를 그대로 옮기지 말 것(저작권).
- API 키는 코드나 저장소에 넣지 않는다. 앱 설정 화면에서 입력하면 사용자 브라우저에만 저장된다.
